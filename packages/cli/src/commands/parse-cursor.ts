import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import type { StatsRecord, ToolCallRecord } from '@aiusage/core'
import { recordIdFor, type RecordIdBuilder } from '@aiusage/core'
import type { CursorCursor } from '../watermark.js'

export interface CursorImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  cursor: CursorCursor | null
  onProgress?: (current: number, total: number, recordsFound: number) => void
}

export interface CursorImportResult {
  records: StatsRecord[]
  toolCalls: ToolCallRecord[]
  nextCursor: CursorCursor | null
  errors: string[]
}

interface ComposerRow {
  key: string
  value: string
}

interface ComposerData {
  composerId: string
  createdAt: number
  /** What tells one state of the conversation from the next; see `CursorCursor.seen`. */
  fingerprint: string
  usageData?: {
    default?: {
      costInCents?: number
      amount?: number
    }
  }
}

interface BubbleTokenCount {
  inputTokens: number
  outputTokens: number
}

interface BubbleData {
  type: number          // 1 = user, 2 = assistant
  tokenCount?: BubbleTokenCount
}

// ── Cursor agent-transcript JSONL parsing (fallback for PRIVACY_MODE_NO_STORAGE) ──

interface AgentTranscriptImportOptions {
  jsonlPath: string
  device: string
  deviceInstanceId: string
  platform?: string
  now: number
}

/**
 * Parse a Cursor agent-transcript JSONL file.
 * In privacy mode (v3.8.23+) state.vscdb bubbles have no token data,
 * but agent-transcript JSONL files contain visible text that we can estimate from.
 * Only non-[REDACTED] text is counted; token estimation is char_count / CHARS_PER_TOKEN.
 */
export function runParseCursorTranscript(options: AgentTranscriptImportOptions): { inputTextChars: number; outputTextChars: number } {
  const charsPerToken = 3
  try {
    const content = readFileSync(options.jsonlPath, 'utf-8')
    const lines = content.split('\n')
    let userChars = 0
    let assistChars = 0

    for (const line of lines) {
      if (!line.trim()) continue
      let data: any
      try { data = JSON.parse(line) } catch { continue }
      const role = data?.role ?? ''
      const blocks = data?.message?.content ?? []
      if (!Array.isArray(blocks)) continue

      for (const block of blocks) {
        if (typeof block !== 'object' || block === null || block.type !== 'text') continue
        const text: string = block.text ?? ''
        // Strip [REDACTED] markers and count remaining visible text
        const clean = text.replace(/\[REDACTED\]/g, '').trim()
        if (!clean) continue
        if (role === 'user') userChars += clean.length
        else if (role === 'assistant') assistChars += clean.length
      }
    }

    return {
      inputTextChars: Math.floor(userChars / charsPerToken),
      outputTextChars: Math.floor(assistChars / charsPerToken),
    }
  } catch {
    return { inputTextChars: 0, outputTextChars: 0 }
  }
}

export function runParseCursor(
  db: Database.Database,
  options: CursorImportOptions,
): CursorImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, onProgress } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const errors: string[] = []
  let lastCursor: CursorCursor | null = null

  // Gracefully skip databases without the expected table (e.g. residual dbs
  // left behind by old/uninstalled Cursor versions)
  const hasTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'`)
    .get()
  if (!hasTable) {
    return { records, toolCalls, nextCursor: lastCursor, errors }
  }

  // Fetch all composerData entries with content.
  // Use an index-friendly range scan instead of LIKE: SQLite's LIKE is
  // case-insensitive by default and cannot use the `key TEXT UNIQUE` index,
  // so every LIKE prefix query degenerates into a full-table scan, which is
  // fatal on multi-GB state.vscdb files. Cursor writes keys with exact
  // lowercase prefixes, so binary range comparison matches the same rows.
  // (';' is the ASCII character right after ':')
  const composerRows = db
    .prepare(`SELECT key, CAST(value AS TEXT) as value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND length(value) > 100`)
    .all() as ComposerRow[]

  // Count the bubbles of every conversation. Only keys are read, so the scan
  // stays inside the key index and never touches a bubble's value.
  const bubbleCounts = new Map<string, number>()
  const bubbleKeys = db
    .prepare(`SELECT key FROM cursorDiskKV WHERE key >= 'bubbleId:' AND key < 'bubbleId;'`)
    .iterate() as IterableIterator<{ key: string }>
  for (const { key } of bubbleKeys) {
    const end = key.indexOf(':', 'bubbleId:'.length)
    if (end < 0) continue
    const composerId = key.slice('bubbleId:'.length, end)
    bubbleCounts.set(composerId, (bubbleCounts.get(composerId) ?? 0) + 1)
  }

  // Parse and filter composerData entries
  const composers: ComposerData[] = []
  for (const row of composerRows) {
    try {
      const j = JSON.parse(row.value)
      const composerId = row.key.slice('composerData:'.length)
      const createdAt: number = j.createdAt ?? 0
      if (!createdAt) continue

      composers.push({
        composerId,
        createdAt,
        // A conversation keeps its creation time while it gains bubbles, so
        // that time cannot say whether it has to be read again. Its bubble
        // count can, together with the markers Cursor itself updates.
        fingerprint: [
          bubbleCounts.get(composerId) ?? 0,
          typeof j.lastUpdatedAt === 'number' ? j.lastUpdatedAt : '',
          typeof j.status === 'string' ? j.status : '',
          j.usageData?.default?.costInCents ?? '',
        ].join(':'),
        usageData: j.usageData,
      })
    } catch {
      // Skip malformed entries
    }
  }

  // Sort by createdAt asc, then composerId asc (for stable ordering)
  composers.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : a.composerId.localeCompare(b.composerId),
  )

  // Read the conversations that changed since they were last read. A cursor
  // without `seen` comes from a release that skipped by creation time and
  // never looked at a conversation twice: everything is read once more.
  const seen = cursor?.seen
  const filtered = seen
    ? composers.filter((c) => seen[c.composerId] !== c.fingerprint)
    : composers

  if (filtered.length === 0) {
    return { records, toolCalls, nextCursor: lastCursor, errors }
  }

  // Conversations that are gone from the database drop out of the map.
  const nextSeen: Record<string, string> = {}
  for (const c of composers) {
    if (seen && seen[c.composerId] !== undefined) nextSeen[c.composerId] = seen[c.composerId]
  }
  const newest = composers[composers.length - 1]

  // Prepare statement to fetch all bubbles for a composer.
  // Range bounds instead of LIKE so the key index is used (see above);
  // otherwise each composer triggers a full-table scan.
  const bubbleStmt = db.prepare(
    `SELECT CAST(value AS TEXT) as value FROM cursorDiskKV WHERE key >= ? AND key < ?`,
  )

  let processed = 0
  for (const composer of filtered) {
    nextSeen[composer.composerId] = composer.fingerprint
    lastCursor = { lastCreatedAt: newest.createdAt, lastId: newest.composerId, seen: nextSeen }
    processed += 1
    onProgress?.(processed, filtered.length, records.length)

    try {
      // Fetch all bubble entries for this conversation
      const bubbleRows = bubbleStmt.all(
        `bubbleId:${composer.composerId}:`,
        `bubbleId:${composer.composerId};`,
      ) as { value: string }[]

      let totalInputTokens = 0
      let totalOutputTokens = 0

      for (const row of bubbleRows) {
        try {
          const bubble: BubbleData = JSON.parse(row.value)
          // Only count assistant (type=2) bubbles with actual token data
          if (bubble.type !== 2) continue
          const tc = bubble.tokenCount
          if (!tc) continue
          totalInputTokens += tc.inputTokens ?? 0
          totalOutputTokens += tc.outputTokens ?? 0
        } catch {
          // Skip malformed bubble entries
        }
      }

      // Skip conversations with no token data
      if (totalInputTokens === 0 && totalOutputTokens === 0) continue

      const ts = composer.createdAt

      // Determine cost from usageData.default.costInCents
      let cost = 0
      let costSource: StatsRecord['costSource'] = 'unknown'
      const defaultUsage = composer.usageData?.default
      if (defaultUsage?.costInCents != null && defaultUsage.costInCents > 0) {
        cost = defaultUsage.costInCents / 100
        costSource = 'log'
      }

      const recordId = recordIdFor(options, `${dbPath}:${composer.composerId}`, ts)

      const record: StatsRecord = {
        id: recordId,
        ts,
        ingestedAt: now,
        updatedAt: now,
        lineOffset: 0,
        tool: 'cursor',
        model: 'cursor-composer',
        provider: 'cursor',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost,
        costSource,
        sessionId: composer.composerId,
        sourceFile: dbPath,
        device,
        deviceInstanceId,
        platform,
      }

      records.push(record)
    } catch (e) {
      // Not read: leave it to be read again on the next run.
      delete nextSeen[composer.composerId]
      errors.push(`composerId ${composer.composerId}: ${e instanceof Error ? e.message : e}`)
    }
  }

  return { records, toolCalls, nextCursor: lastCursor, errors }
}
