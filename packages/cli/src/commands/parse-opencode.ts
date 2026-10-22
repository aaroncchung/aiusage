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
  /**
   * Ids of the records in `records` that had a part which could not be read,
   * so `toolCalls` may be short of calls for them. Their messages are kept
   * for another read.
   */
  incompleteToolCallRecordIds: string[]
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
  finish?: string
  error?: unknown
}

interface ParsedPartData {
  type?: string
  tool?: string
}

/**
 * The most messages kept for another read (`OpenCodeCursor.pendingMessageIds`).
 * A message that never completes, because the process died or the row stays
 * unreadable, would otherwise be kept and read again forever. Beyond this
 * many, the oldest are let go: a response that finishes after this many
 * newer messages were left pending is then no longer picked up.
 */
export const MAX_PENDING_MESSAGES = 500

/**
 * True for an assistant message whose usage may still change. OpenCode (and
 * Kilo, which shares the schema) inserts the assistant message with zero
 * tokens when a response starts and writes the tokens when it ends. Such a
 * message is read again on later runs, or the tokens it gets later are never
 * imported. How old it is says nothing: a response can be resumed after any
 * pause. A message is final once it has a completion time and either tokens
 * or a recorded outcome (`finish` or `error`, as for an aborted response).
 */
export function isUnfinishedAssistantMessage(
  parsed: { role?: string; finish?: string; error?: unknown; time?: { completed?: number }; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } },
): boolean {
  if (parsed.role !== 'assistant') return false
  if (!parsed.time?.completed) return true
  if (parsed.finish || parsed.error) return false
  const t = parsed.tokens
  return !t || ((t.input ?? 0) === 0 && (t.output ?? 0) === 0 && (t.reasoning ?? 0) === 0
    && (t.cache?.read ?? 0) === 0 && (t.cache?.write ?? 0) === 0)
}

/**
 * The cursor after a run that read `messages` (everything past the cursor
 * plus the pending messages behind it, in cursor order) and found `pending`
 * of them unfinished or unreadable. The position moves past everything that
 * was read; what has to be read again is carried by id instead. A pending
 * message that is gone from the database was not read and drops out.
 */
export function nextMessageCursor(
  cursor: OpenCodeCursor | null,
  messages: Array<{ id: string; time_created: number }>,
  pending: string[],
): OpenCodeCursor | null {
  // Nothing read and nothing to forget: the stored cursor stands.
  if (messages.length === 0 && (cursor?.pendingMessageIds?.length ?? 0) === 0) return null
  let lastMessageCreatedAt = cursor?.lastMessageCreatedAt ?? 0
  let lastMessageId = cursor?.lastMessageId ?? ''
  // The position only moves forward: a pending message lies behind it.
  const last = messages[messages.length - 1]
  if (last && (last.time_created > lastMessageCreatedAt || (last.time_created === lastMessageCreatedAt && last.id > lastMessageId))) {
    lastMessageCreatedAt = last.time_created
    lastMessageId = last.id
  }
  return pending.length > 0
    ? { lastMessageCreatedAt, lastMessageId, pendingMessageIds: pending.slice(-MAX_PENDING_MESSAGES) }
    : { lastMessageCreatedAt, lastMessageId }
}

export function runParseOpenCode(
  db: Database.Database,
  options: OpenCodeImportOptions,
): OpenCodeImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, exchangeRate } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const incompleteToolCallRecordIds: string[] = []
  const errors: string[] = []

  // Past the cursor, plus the messages behind it that were unfinished or
  // unreadable when they were last read.
  const messages = db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.data
       FROM message m
       WHERE m.time_created > ? OR (m.time_created = ? AND m.id > ?)
          OR m.id IN (SELECT value FROM json_each(?))
       ORDER BY m.time_created, m.id`,
    )
    .all(
      cursor?.lastMessageCreatedAt ?? 0,
      cursor?.lastMessageCreatedAt ?? 0,
      cursor?.lastMessageId ?? '',
      JSON.stringify(cursor?.pendingMessageIds ?? []),
    ) as MessageRow[]

  const partsStmt = db.prepare(
    `SELECT id, message_id, session_id, time_created, data
     FROM part
     WHERE message_id = ?
     ORDER BY time_created, id`,
  )

  // Messages to read again on the next run. Records keep their ids, so that
  // updates rows in place and leaves unchanged ones alone.
  const pending: string[] = []

  for (const message of messages) {
    let parsed: ParsedMessageData
    try {
      parsed = JSON.parse(message.data) as ParsedMessageData
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    } catch (e) {
      errors.push(`message ${message.id}: invalid JSON: ${e instanceof Error ? e.message : e}`)
      pending.push(message.id)
      continue
    }

    if (isUnfinishedAssistantMessage(parsed)) pending.push(message.id)

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
    let unreadableParts = 0
    for (const part of parts) {
      let partParsed: ParsedPartData

      try {
        partParsed = JSON.parse(part.data) as ParsedPartData
        if (partParsed === null || typeof partParsed !== 'object' || Array.isArray(partParsed)) throw new Error('not an object')
      } catch (e) {
        errors.push(`message ${message.id} part ${part.id}: invalid JSON: ${e instanceof Error ? e.message : e}`)
        unreadableParts++
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

    // The calls read for this record may be short of one. The caller leaves
    // the calls it has stored alone, and the message is read again: this may
    // be the read on which its usage became final, and it would not be
    // visited again otherwise.
    if (unreadableParts > 0) {
      incompleteToolCallRecordIds.push(recordId)
      if (pending[pending.length - 1] !== message.id) pending.push(message.id)
    }
  }

  return { records, toolCalls, incompleteToolCallRecordIds, nextCursor: nextMessageCursor(cursor, messages, pending), errors }
}
