import type Database from 'better-sqlite3'
import type { StatsRecord, ToolCallRecord } from '@aiusage/core'
import { generateToolCallId, inferProvider, calculateCost, recordIdFor, type RecordIdBuilder } from '@aiusage/core'
import type { HermesCursor } from '../watermark.js'

export interface HermesImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  cursor: HermesCursor | null
  exchangeRate?: number
}

export interface HermesImportResult {
  records: StatsRecord[]
  toolCalls: ToolCallRecord[]
  /**
   * Ids of the records in `records` that had a `tool_calls` payload which
   * could not be read, so `toolCalls` may be short of calls for them. Their
   * sessions are kept for another read.
   */
  incompleteToolCallRecordIds: string[]
  nextCursor: HermesCursor | null
  errors: string[]
}

interface SessionRow {
  id: string
  model: string | null
  billing_provider: string | null
  started_at: number
  ended_at: number | null
  session_ts: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  title: string | null
}

interface MessageRow {
  id: number
  session_id: string
  tool_calls: string | null
  timestamp: number
}

export function runParseHermes(
  db: Database.Database,
  options: HermesImportOptions,
): HermesImportResult {
  // One read transaction, so the sessions and the list of open sessions come
  // from the same state of the database: a session that ends between the
  // two queries would be read as open and then not be remembered as open.
  return db.transaction(() => readHermes(db, options))()
}

function readHermes(
  db: Database.Database,
  options: HermesImportOptions,
): HermesImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, exchangeRate } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const incompleteToolCallRecordIds: string[] = []
  // Sessions with a tool_calls payload that could not be read on this run.
  const unreadSessionIds: string[] = []
  const errors: string[] = []
  // Past the cursor, plus every session that is open now, or that was open
  // or could not be read in full when it was last read. A session's totals grow until it ends, and it can end
  // at a time the cursor has already passed (another session ended later),
  // so the cursor alone would leave it at whatever it held when first seen.
  const reread = JSON.stringify(cursor?.openSessionIds ?? [])
  // A cursor without that list was written by a release that did not track
  // open sessions. It may have passed a session that was imported while open
  // and has ended since, and nothing says which: every session is read once
  // more. Records keep their ids, so that updates them in place.
  const from = cursor?.openSessionIds ? cursor : null

  const sessions = db
    .prepare(
      `SELECT id, model, billing_provider, started_at, ended_at,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, estimated_cost_usd, actual_cost_usd, title,
              COALESCE(ended_at, started_at) AS session_ts
       FROM sessions
       WHERE (ended_at IS NOT NULL OR input_tokens > 0 OR output_tokens > 0)
         AND (COALESCE(ended_at, started_at) > ? OR (COALESCE(ended_at, started_at) = ? AND id > ?)
              OR ended_at IS NULL
              OR id IN (SELECT value FROM json_each(?)))
       ORDER BY COALESCE(ended_at, started_at), id`,
    )
    .all(
      from?.lastEndedAt ?? 0,
      from?.lastEndedAt ?? 0,
      from?.lastId ?? '',
      reread,
    ) as SessionRow[]

  // The cursor only moves forward: a session read again because it is open
  // lies behind it.
  let lastEndedAt = cursor?.lastEndedAt ?? 0
  let lastId = cursor?.lastId ?? ''
  // Every open session, also one the query above leaves out because it has
  // no usage yet: it can get its usage and end behind the cursor like any
  // other.
  const openSessionIds = db
    .prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at, id')
    .pluck()
    .all() as string[]

  const toolCallsStmt = db.prepare(
    `SELECT id, session_id, tool_calls, timestamp
     FROM messages
     WHERE session_id = ? AND tool_calls IS NOT NULL
     ORDER BY timestamp, id`,
  )

  for (const session of sessions) {
    if (session.session_ts > lastEndedAt || (session.session_ts === lastEndedAt && session.id > lastId)) {
      lastEndedAt = session.session_ts
      lastId = session.id
    }

    const model = session.model ?? 'unknown'
    const ts = Math.round(session.started_at * 1000)

    const rawProvider = session.billing_provider
    const provider = (rawProvider && rawProvider !== 'custom')
      ? rawProvider
      : inferProvider(model)

    const inputTokens = session.input_tokens
    const outputTokens = session.output_tokens
    const cacheReadTokens = session.cache_read_tokens
    const cacheWriteTokens = session.cache_write_tokens
    const thinkingTokens = session.reasoning_tokens

    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens }

    let cost: number
    let costSource: StatsRecord['costSource']

    if (session.actual_cost_usd != null && session.actual_cost_usd > 0) {
      cost = session.actual_cost_usd
      costSource = 'log'
    } else if (session.estimated_cost_usd != null && session.estimated_cost_usd > 0) {
      cost = session.estimated_cost_usd
      costSource = 'log'
    } else if (model !== 'unknown') {
      cost = calculateCost(model, tokenArgs, exchangeRate)
      costSource = cost > 0 ? 'pricing' : 'unknown'
    } else {
      cost = 0
      costSource = 'unknown'
    }

    const recordId = recordIdFor(options, dbPath + ':' + session.id, ts)

    // Use a per-session sourceFile so project extraction can differentiate sessions.
    // Format: /path/to/state.db:session:<id>:<title>
    const sessionTitle = (session.title || '').replace(/[/\\:]/g, '_').slice(0, 80)
    const sourceFile = sessionTitle
      ? `${dbPath}:session:${session.id}:${sessionTitle}`
      : `${dbPath}:session:${session.id}`

    const record: StatsRecord = {
      id: recordId,
      ts,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: 0,
      tool: 'hermes',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost,
      costSource,
      sessionId: session.id,
      sourceFile,
      device,
      deviceInstanceId,
      platform,
    }

    records.push(record)

    // Extract tool calls from messages
    const messages = toolCallsStmt.all(session.id) as MessageRow[]
    let callIndex = 0
    let unreadablePayloads = 0
    for (const message of messages) {
      let toolCallList: Array<{ function?: { name?: string } } | null>
      try {
        const parsed = JSON.parse(message.tool_calls!)
        if (!Array.isArray(parsed)) {
          errors.push(`session ${session.id} message ${message.id}: tool_calls payload is not an array`)
          unreadablePayloads++
          continue
        }
        toolCallList = parsed as Array<{ function?: { name?: string } } | null>
      } catch (e) {
        errors.push(`session ${session.id} message ${message.id}: invalid tool_calls JSON: ${e instanceof Error ? e.message : e}`)
        unreadablePayloads++
        continue
      }
      for (const tc of toolCallList) {
        const name = tc?.function?.name
        if (!name) continue
        toolCalls.push({
          id: generateToolCallId(recordId, name, Math.round(message.timestamp * 1000), callIndex),
          recordId,
          name,
          ts: Math.round(message.timestamp * 1000),
          callIndex,
        })
        callIndex++
      }
    }

    // The calls read for this record may be short of some. The caller leaves
    // the calls it has stored alone, and the session is read again like an
    // open one: it may have ended, and would not be visited again otherwise.
    if (unreadablePayloads > 0) {
      incompleteToolCallRecordIds.push(recordId)
      if (!openSessionIds.includes(session.id)) unreadSessionIds.push(session.id)
    }
  }

  const rereadSessionIds = [...openSessionIds, ...unreadSessionIds]
  // Nothing read and nothing to forget: the stored cursor stands, unless it
  // still has to be given its list of open sessions.
  const nextCursor: HermesCursor | null = sessions.length > 0 || rereadSessionIds.length > 0 || (cursor?.openSessionIds?.length ?? 0) > 0 || (cursor != null && !from)
    ? { lastEndedAt, lastId, openSessionIds: rereadSessionIds }
    : null
  return { records, toolCalls, incompleteToolCallRecordIds, nextCursor, errors }
}
