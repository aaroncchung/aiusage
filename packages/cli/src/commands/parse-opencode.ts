import type Database from 'better-sqlite3'
import type { StatsRecord, ToolCallRecord } from '@aiusage/core'
import { generateToolCallId, inferProvider, calculateCost, recordIdFor, type RecordIdBuilder } from '@aiusage/core'
import type { OpenCodeCursor } from '../watermark.js'

export interface OpenCodeImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  cursor: OpenCodeCursor | null
  exchangeRate?: number
}

export interface OpenCodeImportResult {
  records: StatsRecord[]
  toolCalls: ToolCallRecord[]
  nextCursor: OpenCodeCursor | null
  errors: string[]
}

interface MessageRow {
  id: string
  session_id: string
  time_created: number
  data: string
}

interface PartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: string
}

interface ParsedMessageData {
  role: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
}

interface ParsedPartData {
  type?: string
  tool?: string
}

/**
 * How long an assistant message that looks unfinished holds the cursor back.
 * A response does not take a day; a message that is still unfinished after
 * that was abandoned (the process died), and waiting for it would make every
 * later run read everything after it again, forever.
 */
export const UNFINISHED_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * True for an assistant message whose usage may still change. OpenCode (and
 * Kilo, which shares the schema) inserts the assistant message with zero
 * tokens when a response starts and writes the tokens when it ends. The
 * cursor must not move past such a message, or the tokens it gets later are
 * never imported.
 */
export function isUnfinishedAssistantMessage(
  parsed: { role?: string; time?: { completed?: number }; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } },
  timeCreated: number,
  now: number,
): boolean {
  if (parsed.role !== 'assistant') return false
  if (now - timeCreated >= UNFINISHED_MESSAGE_MAX_AGE_MS) return false
  if (!parsed.time?.completed) return true
  const t = parsed.tokens
  return !t || ((t.input ?? 0) === 0 && (t.output ?? 0) === 0 && (t.reasoning ?? 0) === 0
    && (t.cache?.read ?? 0) === 0 && (t.cache?.write ?? 0) === 0)
}

export function runParseOpenCode(
  db: Database.Database,
  options: OpenCodeImportOptions,
): OpenCodeImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, exchangeRate } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const errors: string[] = []
  let lastCursor: OpenCodeCursor | null = null

  const messages = db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.data
       FROM message m
       WHERE m.time_created > ? OR (m.time_created = ? AND m.id > ?)
       ORDER BY m.time_created, m.id`,
    )
    .all(
      cursor?.lastMessageCreatedAt ?? 0,
      cursor?.lastMessageCreatedAt ?? 0,
      cursor?.lastMessageId ?? '',
    ) as MessageRow[]

  const partsStmt = db.prepare(
    `SELECT id, message_id, session_id, time_created, data
     FROM part
     WHERE message_id = ?
     ORDER BY time_created, id`,
  )

  // The cursor stops in front of the first message that may still change.
  // Everything after it is read again on the next run; records keep their
  // ids, so that updates rows in place and leaves unchanged ones alone.
  let cursorHeld = false
  const advanceCursor = (message: MessageRow): void => {
    if (cursorHeld) return
    lastCursor = { lastMessageCreatedAt: message.time_created, lastMessageId: message.id }
  }

  for (const message of messages) {
    let parsed: ParsedMessageData
    try {
      parsed = JSON.parse(message.data) as ParsedMessageData
    } catch (e) {
      errors.push(`message ${message.id}: invalid JSON: ${e instanceof Error ? e.message : e}`)
      advanceCursor(message)
      continue
    }

    if (isUnfinishedAssistantMessage(parsed, message.time_created, now)) cursorHeld = true
    advanceCursor(message)

    // Only process assistant messages with tokens
    if (parsed.role !== 'assistant' || !parsed.tokens) continue

    const inputTokens = parsed.tokens.input ?? 0
    const outputTokens = parsed.tokens.output ?? 0
    const reasoningTokens = parsed.tokens.reasoning ?? 0
    const cacheReadTokens = parsed.tokens.cache?.read ?? 0
    const cacheWriteTokens = parsed.tokens.cache?.write ?? 0

    // Skip messages with no token usage
    if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) continue

    const model = parsed.modelID ?? 'unknown'
    const provider = parsed.providerID ?? inferProvider(model)
    const ts = parsed.time?.created ?? message.time_created

    const recordId = recordIdFor(options, dbPath + ':' + message.id, message.time_created)

    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens: reasoningTokens }
    const calculatedCost = model !== 'unknown' ? calculateCost(model, tokenArgs, exchangeRate) : 0
    // OpenCode often logs cost:0 even for paid models; fall back to pricing table when that happens
    const logCost = parsed.cost
    const logCostValid = logCost != null && logCost > 0
    const cost = logCostValid ? logCost : calculatedCost
    const costSource: StatsRecord['costSource'] = logCostValid ? 'log' : calculatedCost > 0 ? 'pricing' : 'unknown'

    const record: StatsRecord = {
      id: recordId,
      ts,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: 0, // DB-sourced records have no byte offset; use 0 as sentinel
      tool: 'opencode',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens: reasoningTokens,
      cost,
      costSource,
      sessionId: message.session_id,
      sourceFile: dbPath,
      device,
      deviceInstanceId,
      platform,
    }

    records.push(record)

    // Load tool parts for this message
    const parts = partsStmt.all(message.id) as PartRow[]
    let callIndex = 0
    for (const part of parts) {
      let partParsed: ParsedPartData

      try {
        partParsed = JSON.parse(part.data) as ParsedPartData
      } catch (e) {
        errors.push(`message ${message.id} part ${part.id}: invalid JSON: ${e instanceof Error ? e.message : e}`)
        continue
      }

      if (partParsed.type === 'tool' && partParsed.tool) {
        toolCalls.push({
          id: generateToolCallId(recordId, partParsed.tool, part.time_created, callIndex),
          recordId,
          name: partParsed.tool,
          ts: part.time_created,
          callIndex,
        })
        callIndex++
      }
    }
  }

  return { records, toolCalls, nextCursor: lastCursor, errors }
}
