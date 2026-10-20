import type Database from 'better-sqlite3'
import type { RecordIdBuilder, RecordOrigin, StatsRecord, Tool } from '@aiusage/core'
import { generateRecordId, generateSyncRecordId } from '@aiusage/core'
import { mapStatsRecordToSyncRecord, usesGeneratedWireId } from '../sync/mapper.js'

/**
 * Sentinel device id used by parsers that ran before `state.json` existed.
 * Such rows were still produced on this device, so they count as local; parse
 * re-labels them to the real device id on its next run.
 */
export const UNKNOWN_DEVICE_INSTANCE_ID = 'unknown'

/**
 * SQL fragment (no leading AND) selecting rows that were parsed on this device.
 * Use this — never `source_file NOT LIKE 'synced/%'` — to exclude records that
 * were pulled from other devices and merged into `records`.
 */
export const LOCAL_RECORDS_WHERE = "origin = 'local'"

/**
 * True when `record` may be uploaded under `deviceInstanceId`'s sync namespace:
 * it must have been parsed here (origin = local) and carry this device's id
 * (or the pre-init 'unknown' sentinel, which only local parsing can produce).
 * Pulled records — whatever their `source_file` — never satisfy this.
 */
export function isUploadableLocalRecord(
  record: Pick<StatsRecord, 'origin' | 'deviceInstanceId'>,
  deviceInstanceId: string,
): boolean {
  if ((record.origin ?? 'local') !== 'local') return false
  return record.deviceInstanceId === deviceInstanceId
    || record.deviceInstanceId === UNKNOWN_DEVICE_INSTANCE_ID
}

/** Columns a re-insert overwrites with the incoming value. */
const OVERWRITTEN_COLUMNS = [
  'ts', 'line_offset', 'tool', 'model', 'provider', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'thinking_tokens', 'cost', 'cost_source',
  'session_id', 'source_file', 'device', 'device_instance_id', 'origin',
]
/**
 * Columns a re-insert overwrites only with a non-empty value. Most parsers
 * supply neither: `cwd` is filled in after the insert from the head of the
 * source file, `platform` by a backfill. An empty incoming value says nothing
 * about the stored one and must not erase it.
 */
const KEPT_WHEN_EMPTY_COLUMNS = ['cwd', 'platform']

const RECORD_CHANGED = [
  `(${OVERWRITTEN_COLUMNS.map(c => `records.${c}`).join(', ')}) IS NOT (${OVERWRITTEN_COLUMNS.map(c => `excluded.${c}`).join(', ')})`,
  ...KEPT_WHEN_EMPTY_COLUMNS.map(c => `(excluded.${c} != '' AND records.${c} IS NOT excluded.${c})`),
].join('\n        OR ')

/**
 * Write a parsed record, updating the row in place when its id already exists.
 *
 * An existing row is never deleted and re-created (`INSERT OR REPLACE` does
 * that, which cascades to the row's `tool_calls` and `sync_record_state`). It
 * keeps its `ingested_at` and `synced_at`, and its `updated_at` moves only
 * when a stored field actually changed, so reading a source again leaves an
 * unchanged record synced on every target while a changed one is queued again.
 * A changed row always gets an `updated_at` above the one it had and above
 * every acknowledgement stored for it: a cloud target acknowledges the
 * `updated_at` it was sent (see `markRecordVersionsSynced`) and a file
 * backend the time of its upload, and a record counts as unsynced only while
 * `updated_at` is greater. A new version must therefore never reuse or fall
 * below those values, whatever the caller's clock says.
 */
export function insertRecord(db: Database.Database, record: StatsRecord): void {
  db.prepare(`
    INSERT INTO records (
      id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_id, source_file, cwd, device, device_instance_id, platform, origin
    ) VALUES (
      @id, @ts, @ingestedAt, @syncedAt, @updatedAt, @lineOffset,
      @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionId, @sourceFile, @cwd, @device, @deviceInstanceId, @platform, @origin
    )
    ON CONFLICT(id) DO UPDATE SET
      ${OVERWRITTEN_COLUMNS.map(c => `${c} = excluded.${c}`).join(',\n      ')},
      ${KEPT_WHEN_EMPTY_COLUMNS.map(c => `${c} = CASE WHEN excluded.${c} != '' THEN excluded.${c} ELSE records.${c} END`).join(',\n      ')},
      updated_at = CASE
        WHEN ${RECORD_CHANGED}
        THEN MAX(
          excluded.updated_at,
          records.updated_at + 1,
          COALESCE(records.synced_at, 0) + 1,
          COALESCE((SELECT MAX(s.synced_at) FROM sync_record_state s WHERE s.record_id = records.id), 0) + 1
        )
        ELSE records.updated_at
      END
  `).run({
    id: record.id,
    ts: record.ts,
    ingestedAt: record.ingestedAt,
    syncedAt: record.syncedAt ?? null,
    updatedAt: record.updatedAt,
    lineOffset: record.lineOffset,
    tool: record.tool,
    model: record.model,
    provider: record.provider,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    thinkingTokens: record.thinkingTokens,
    cost: record.cost,
    costSource: record.costSource,
    sessionId: record.sessionId,
    sourceFile: record.sourceFile,
    cwd: record.cwd ?? '',
    device: record.device,
    deviceInstanceId: record.deviceInstanceId,
    platform: record.platform ?? '',
    origin: record.origin ?? 'local',
  })
}

/**
 * Fields a parser can change. Bookkeeping is deliberately excluded:
 * `ingested_at`, `updated_at`, `synced_at`, `line_offset` and `source_file`
 * describe *when and from where* a row was read, not what it says. `origin` is
 * excluded too, so a value-identical row that arrived from another device keeps
 * its provenance instead of being re-labelled as local work.
 */
function recordValuesEqual(existing: StatsRecord, incoming: StatsRecord): boolean {
  return existing.ts === incoming.ts
    && existing.tool === incoming.tool
    && existing.model === incoming.model
    && existing.provider === incoming.provider
    && existing.inputTokens === incoming.inputTokens
    && existing.outputTokens === incoming.outputTokens
    && existing.cacheReadTokens === incoming.cacheReadTokens
    && existing.cacheWriteTokens === incoming.cacheWriteTokens
    && existing.thinkingTokens === incoming.thinkingTokens
    && existing.cost === incoming.cost
    && existing.costSource === incoming.costSource
    && existing.sessionId === incoming.sessionId
    && (existing.cwd ?? '') === (incoming.cwd ?? '')
    && existing.device === incoming.device
    && existing.deviceInstanceId === incoming.deviceInstanceId
    && (existing.platform ?? '') === (incoming.platform ?? '')
}

/**
 * Writes only the records whose values changed, and returns how many rows were
 * written.
 *
 * Sources that are re-read in full — a SQLite database whose pages are
 * rewritten in place, or a backup archive that re-produces messages already
 * imported — hand back records that are already stored. Rewriting those
 * unchanged would move `updated_at` past `synced_at` and drop `synced_at`
 * entirely, so every re-import marked the whole history as unsynced work.
 * An identical record is now left exactly as it is.
 */
export function insertChangedRecords(db: Database.Database, records: StatsRecord[]): number {
  if (records.length === 0) return 0

  const existing = new Map<string, StatsRecord>()
  const chunkSize = 400
  for (let start = 0; start < records.length; start += chunkSize) {
    const ids = records.slice(start, start + chunkSize).map((record) => record.id)
    const rows = db
      .prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as Record<string, unknown>[]
    for (const row of rows) existing.set(row.id as string, mapRowToRecord(row))
  }

  let written = 0
  const write = db.transaction((items: StatsRecord[]) => {
    for (const record of items) {
      const prior = existing.get(record.id)
      if (prior && recordValuesEqual(prior, record)) continue
      insertRecord(db, record)
      written++
    }
  })
  write(records)
  return written
}

export function getRecordById(db: Database.Database, id: string): StatsRecord | null {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapRowToRecord(row)
}

export function getRecordsBySourceFile(db: Database.Database, sourceFile: string): StatsRecord[] {
  const rows = db.prepare('SELECT * FROM records WHERE source_file = ?').all(sourceFile) as Record<string, unknown>[]
  return rows.map(mapRowToRecord)
}

export function deleteRecordsBySourceFile(db: Database.Database, sourceFile: string): number {
  const result = db.prepare('DELETE FROM records WHERE source_file = ?').run(sourceFile)
  return result.changes
}

/**
 * Local records that still need uploading.
 *
 * Only rows with `origin = 'local'` are candidates: rows merged from
 * `synced_records` are never returned, regardless of their `source_file`.
 * When `deviceInstanceId` is given, candidates are additionally restricted to
 * rows carrying that device id (or the pre-init 'unknown' sentinel), so a row
 * stamped with another device's id can never be uploaded under this device's
 * namespace even if its provenance flag were wrong.
 */
export function getUnsyncedRecords(db: Database.Database, target?: string, deviceInstanceId?: string): StatsRecord[] {
  const ownerWhere = deviceInstanceId !== undefined
    ? `AND r.device_instance_id IN (@deviceInstanceId, '${UNKNOWN_DEVICE_INSTANCE_ID}')`
    : ''
  const ownerParams = deviceInstanceId !== undefined ? { deviceInstanceId } : {}

  const rows = target
    ? db.prepare(`
        SELECT r.* FROM records r
        LEFT JOIN sync_record_state s
          ON s.record_id = r.id AND s.target = @target
        WHERE r.${LOCAL_RECORDS_WHERE}
          ${ownerWhere}
          AND (s.synced_at IS NULL OR r.updated_at > s.synced_at)
      `).all({ target, ...ownerParams }) as Record<string, unknown>[]
    : db.prepare(`
        SELECT r.* FROM records r
        WHERE r.${LOCAL_RECORDS_WHERE}
          ${ownerWhere}
          AND (r.synced_at IS NULL OR r.updated_at > r.synced_at)
      `).all(ownerParams) as Record<string, unknown>[]
  return rows.map(mapRowToRecord)
}

export function markRecordsSynced(db: Database.Database, ids: string[], syncedAt: number, target?: string): void {
  if (ids.length === 0) return

  if (target) {
    const insertStmt = db.prepare(`
      INSERT INTO sync_record_state (record_id, target, synced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(record_id, target) DO UPDATE SET synced_at = excluded.synced_at
    `)
    const legacyStmt = db.prepare('UPDATE records SET synced_at = ? WHERE id = ?')
    const tx = db.transaction((recordIds: string[]) => {
      for (const id of recordIds) {
        insertStmt.run(id, target, syncedAt)
        legacyStmt.run(syncedAt, id)
      }
    })
    tx(ids)
    return
  }

  const updateStmt = db.prepare('UPDATE records SET synced_at = ? WHERE id = ?')
  const tx = db.transaction((recordIds: string[]) => {
    for (const id of recordIds) updateStmt.run(syncedAt, id)
  })
  tx(ids)
}

/**
 * Acknowledge the versions of records a target has accepted. Each entry names
 * a record and the `updated_at` it had when it was read for sending.
 *
 * The acknowledgement is that `updated_at`, not the time of the call: a
 * record counts as unsynced while `updated_at > synced_at`, so a version
 * written after the one that was sent stays unsynced whenever it is written.
 * A row whose `updated_at` no longer equals the one sent is not marked at
 * all, and neither is a row deleted in the meantime — the upload awaits the
 * network, so the parser can rewrite a record between the read and this call.
 * Returns the number of records acknowledged.
 */
export function markRecordVersionsSynced(
  db: Database.Database,
  versions: Array<Pick<StatsRecord, 'id' | 'updatedAt'>>,
  target: string,
): number {
  if (versions.length === 0) return 0

  const insertStmt = db.prepare(`
    INSERT INTO sync_record_state (record_id, target, synced_at)
    SELECT id, @target, updated_at FROM records WHERE id = @id AND updated_at = @updatedAt
    ON CONFLICT(record_id, target) DO UPDATE SET synced_at = excluded.synced_at
  `)
  const legacyStmt = db.prepare('UPDATE records SET synced_at = updated_at WHERE id = @id AND updated_at = @updatedAt')
  return db.transaction(() => {
    let marked = 0
    for (const { id, updatedAt } of versions) {
      marked += insertStmt.run({ id, updatedAt, target }).changes
      legacyStmt.run({ id, updatedAt })
    }
    return marked
  })()
}

/**
 * Forget what `target` has acknowledged, so every local record counts as
 * unsynced for it again. Used when the target's data was replaced by an empty
 * dataset (a new cloud sync generation). Returns the number of rows removed.
 */
export function clearSyncRecordState(db: Database.Database, target: string): number {
  return db.prepare('DELETE FROM sync_record_state WHERE target = ?').run(target).changes
}

/**
 * Runtime provenance guard, run at the start of every sync once the current
 * device id is known (migrations cannot know it).
 *
 * Any `origin = 'local'` row stamped with a *different, concrete* device id
 * cannot have been produced by a parser on this device — parsers always stamp
 * the current id (or 'unknown' before init). Such rows are pulled copies whose
 * merge fingerprint was lost (e.g. the origin device renamed its alias and
 * re-uploaded, changing the session key), so they are re-flagged as `synced`.
 * Nothing is deleted; the rows remain visible via `synced_records`.
 * Returns the number of rows re-flagged.
 */
export function repairRecordProvenance(db: Database.Database, deviceInstanceId: string): number {
  const result = db.prepare(`
    UPDATE records
    SET origin = 'synced'
    WHERE origin = 'local'
      AND device_instance_id != ?
      AND device_instance_id != '${UNKNOWN_DEVICE_INSTANCE_ID}'
  `).run(deviceInstanceId)
  if (result.changes > 0) {
    db.prepare(`
      DELETE FROM sync_record_state
      WHERE record_id IN (SELECT id FROM records WHERE origin = 'synced')
    `).run()
  }
  return result.changes
}

function mapRowToRecord(row: Record<string, unknown>): StatsRecord {
  return {
    id: row.id as string,
    ts: row.ts as number,
    ingestedAt: row.ingested_at as number,
    syncedAt: row.synced_at != null ? (row.synced_at as number) : undefined,
    updatedAt: row.updated_at as number,
    lineOffset: row.line_offset as number,
    tool: row.tool as StatsRecord['tool'],
    model: row.model as string,
    provider: row.provider as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    thinkingTokens: row.thinking_tokens as number,
    cost: row.cost as number,
    costSource: row.cost_source as StatsRecord['costSource'],
    sessionId: row.session_id as string,
    sourceFile: row.source_file as string,
    cwd: (row.cwd as string) || undefined,
    device: row.device as string,
    deviceInstanceId: row.device_instance_id as string,
    platform: (row.platform as string) || undefined,
    origin: ((row.origin as string) || 'local') as RecordOrigin,
  }
}

/**
 * Local rows still stamped `'unknown'` that were already published somewhere
 * travel, for tools whose wire id is generated from the device id, under
 * `sha256('unknown', sourceFile, lineOffset)`. Adopting them under the real
 * device id changes that wire id, so the old one must be retired on every
 * target that received it (file backends drop it with the next snapshot, the
 * cloud backend pushes a tombstone) and the row must be published again. This
 * records the retired ids and clears the rows' sync state; it does not
 * relabel anything. Returns the number of `(target, wire id)` pairs retired.
 */
export function retireWireIdsOfUnknownLocalRows(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT s.record_id, s.target, r.tool, r.source_file, r.line_offset
    FROM sync_record_state s
    JOIN records r ON r.id = s.record_id
    WHERE r.${LOCAL_RECORDS_WHERE} AND r.device_instance_id = '${UNKNOWN_DEVICE_INSTANCE_ID}'
  `).all() as Array<{ record_id: string; target: string; tool: Tool; source_file: string; line_offset: number }>
  const affected = rows.filter(r => usesGeneratedWireId(r.tool))
  if (affected.length === 0) return 0

  const retire = db.prepare(`INSERT OR IGNORE INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)`)
  const forget = db.prepare(`DELETE FROM sync_record_state WHERE record_id = ? AND target = ?`)
  const requeue = db.prepare(`UPDATE records SET synced_at = NULL WHERE id = ?`)
  return db.transaction(() => {
    let retired = 0
    for (const row of affected) {
      retired += retire.run(row.target, generateSyncRecordId(UNKNOWN_DEVICE_INSTANCE_ID, row.source_file, row.line_offset)).changes
      forget.run(row.record_id, row.target)
      requeue.run(row.record_id)
    }
    return retired
  })()
}

/**
 * Re-label locally parsed rows that still carry the pre-init `'unknown'`
 * sentinel with the real device id. Only `origin = 'local'` rows qualify: a
 * pulled row is never relabelled, whatever its device id says. Rows that had
 * already been published under the sentinel have their old wire ids retired
 * first (see `retireWireIdsOfUnknownLocalRows`). Returns the number of rows
 * updated.
 */
export function backfillUnknownDeviceInstanceId(db: Database.Database, deviceInstanceId: string, device?: string): number {
  if (!deviceInstanceId || deviceInstanceId === UNKNOWN_DEVICE_INSTANCE_ID) return 0
  return db.transaction(() => {
    retireWireIdsOfUnknownLocalRows(db)
    const result = device !== undefined
      ? db.prepare(`
          UPDATE records SET device_instance_id = ?, device = ?
          WHERE device_instance_id = '${UNKNOWN_DEVICE_INSTANCE_ID}' AND ${LOCAL_RECORDS_WHERE}
        `).run(deviceInstanceId, device)
      : db.prepare(`
          UPDATE records SET device_instance_id = ?
          WHERE device_instance_id = '${UNKNOWN_DEVICE_INSTANCE_ID}' AND ${LOCAL_RECORDS_WHERE}
        `).run(deviceInstanceId)
    return result.changes
  })()
}

/**
 * The row a release without `recordIdsForReread` stored for a record a
 * second time, under the device's own id.
 */
export interface RecordCopy {
  /** The copy's id. */
  id: string
  /**
   * Where the copy was stored (`source_file`, `line_offset`), when this parse
   * found it and folded it into the original. A copy written before tool
   * calls were keyed on their block (v1.5.22) holds the calls of that line.
   */
  sourceFile?: string
  lineOffset?: number
}

/** The record ids of one parse: see `recordIdsForReread`. */
export interface RereadRecordIds {
  /** Builds a record's id; pass it to the importers as their `recordId`. */
  recordId: RecordIdBuilder
  /**
   * For an id `recordId` returned from the `'unknown'` sentinel, the id the
   * same record has under the device's own id: the id of the copy that a
   * release without this lookup stored. `foldRecordCopy` keeps a Claude Code
   * copy's calls under the original, still under ids built from the copy's
   * (see `deleteAdoptedToolCall`).
   */
  copyOf(id: string): RecordCopy | undefined
}

/**
 * Builds the record ids of a parse, for every importer: any of them can read
 * a record it has stored before (a one-time re-import, a file or database
 * that is read in full again, a lost watermark).
 *
 * A row parsed while the installation had no device id (before v1.5.22, every
 * installation without sync) was stored under the id built from the
 * `'unknown'` sentinel, and keeps that id when
 * `backfillUnknownDeviceInstanceId` relabels it. Built from the device's own
 * id, the same record read again would get a second id and be stored twice.
 * `recordId` returns the sentinel's id while a local row of this device is
 * stored under it, and the device's own id otherwise.
 *
 * A record that is stored under both ids was stored twice by a release
 * without this lookup, and the row under the device's own id is the copy: it
 * is folded into the original and deleted when the lookup finds it (see
 * `foldRecordCopy`), before the caller writes what it has just read.
 */
export function recordIdsForReread(db: Database.Database, deviceInstanceId: string): RereadRecordIds {
  if (!deviceInstanceId || deviceInstanceId === UNKNOWN_DEVICE_INSTANCE_ID) {
    return { recordId: (seed, offset) => generateRecordId(deviceInstanceId, seed, offset), copyOf: () => undefined }
  }
  const stored = db.prepare(`
    SELECT source_file, line_offset FROM records
    WHERE id = ? AND ${LOCAL_RECORDS_WHERE} AND device_instance_id IN (?, '${UNKNOWN_DEVICE_INSTANCE_ID}')
  `)
  // Every line of a message, and every pass over a line before the
  // watermark, asks for the same id: answer each seed once per parse.
  const resolved = new Map<string, string>()
  const copies = new Map<string, RecordCopy>()
  return {
    recordId: (seed, offset) => {
      const key = `${seed}\0${offset}`
      const known = resolved.get(key)
      if (known !== undefined) return known
      const id = generateRecordId(deviceInstanceId, seed, offset)
      const sentinelId = generateRecordId(UNKNOWN_DEVICE_INSTANCE_ID, seed, offset)
      let result = id
      if (stored.get(sentinelId, deviceInstanceId)) {
        result = sentinelId
        const copy: RecordCopy = { id }
        const place = stored.get(id, deviceInstanceId) as { source_file: string; line_offset: number } | undefined
        if (place && foldRecordCopy(db, id, sentinelId)) {
          copy.sourceFile = place.source_file
          copy.lineOffset = place.line_offset
        }
        copies.set(sentinelId, copy)
      }
      resolved.set(key, result)
      return result
    },
    copyOf: (id) => copies.get(id),
  }
}

/**
 * How a Claude Code record's state in `a` compares with `b`: by timestamp,
 * then by output tokens, as `runParse` orders the lines of a message (each
 * line carries the usage so far). Positive when `a` is the later state.
 */
function claudeCodeStateOrder(a: StatsRecord, b: StatsRecord): number {
  return a.ts !== b.ts ? a.ts - b.ts : a.outputTokens - b.outputTokens
}

/**
 * Folds `copyId`, a second row of the record stored under `originalId`, into
 * the original and deletes it. Only call this with proof that both rows are
 * one record, such as both ids being built from the same seed.
 *
 * The copy was written by the later read, so its measurements replace the
 * original's (`insertRecord` moves `updated_at` only when they differ). A
 * Claude Code message can be read from several transcripts that hold it at
 * different stages, so there they replace the original's only when they are
 * the later state. The original keeps its id, its place in its source
 * (`source_file`, `line_offset`, `session_id`), its import time and its sync
 * state, which can be older than the copy.
 *
 * Claude Code calls are keyed on their `tool_use` block, and the copy's can
 * come from a transcript that no longer exists, so they are kept under the
 * original; reading a block again replaces its adopted call
 * (`deleteAdoptedToolCall`). Other tools key their calls on the record, and
 * the original holds the same calls, so the copy's go with it, as does its
 * sync state. A sync target that acknowledged the copy under a wire id that
 * no remaining row publishes gets that id retired, as migration v14 retires
 * ids: the cloud receives a tombstone (unless a row is published under it by
 * then, see `unretirePublishedWireIds`), and a file target leaves the copy out
 * of its next snapshot. Returns false, changing nothing, unless both rows are
 * local.
 */
export function foldRecordCopy(db: Database.Database, copyId: string, originalId: string): boolean {
  return db.transaction(() => {
    const copy = getRecordById(db, copyId)
    const original = getRecordById(db, originalId)
    if (!copy || !original || copyId === originalId) return false
    if (copy.origin !== 'local' || original.origin !== 'local') return false

    const claudeCode = copy.tool === 'claude-code'
    if (!claudeCode || claudeCodeStateOrder(copy, original) > 0) {
      insertRecord(db, {
        ...original,
        ts: copy.ts,
        model: copy.model,
        provider: copy.provider,
        inputTokens: copy.inputTokens,
        outputTokens: copy.outputTokens,
        cacheReadTokens: copy.cacheReadTokens,
        cacheWriteTokens: copy.cacheWriteTokens,
        thinkingTokens: copy.thinkingTokens,
        cost: copy.cost,
        costSource: copy.costSource,
      })
    }
    if (claudeCode) {
      db.prepare('UPDATE tool_calls SET record_id = ? WHERE record_id = ?').run(originalId, copyId)
    }

    const targets = (db.prepare('SELECT target FROM sync_record_state WHERE record_id = ?').all(copyId) as Array<{ target: string }>)
      .map(row => row.target)
    const wireId = mapStatsRecordToSyncRecord(copy).id
    db.prepare('DELETE FROM records WHERE id = ?').run(copyId)
    if (targets.length > 0 && !isWireIdPublished(db, wireId, copy.deviceInstanceId, copy)) {
      const retire = db.prepare('INSERT OR IGNORE INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)')
      for (const target of targets) retire.run(target, wireId)
    }
    return true
  })()
}

/** The wire id `row` is published under once a row still labelled `'unknown'` is relabelled. */
function publishedWireId(row: Record<string, unknown>, deviceInstanceId: string): string {
  const record = mapRowToRecord(row)
  const publishedAs = record.deviceInstanceId === UNKNOWN_DEVICE_INSTANCE_ID ? deviceInstanceId : record.deviceInstanceId
  return mapStatsRecordToSyncRecord({ ...record, deviceInstanceId: publishedAs }).id
}

/**
 * True when a local row is published under `wireId`. Only a row with that id
 * or one at the same place in the same source can be.
 */
function isWireIdPublished(
  db: Database.Database,
  wireId: string,
  deviceInstanceId: string,
  near: Pick<StatsRecord, 'sourceFile' | 'lineOffset'>,
): boolean {
  const rows = db.prepare(`
    SELECT * FROM records
    WHERE ${LOCAL_RECORDS_WHERE} AND (id = ? OR (source_file = ? AND line_offset = ?))
  `).all(wireId, near.sourceFile, near.lineOffset) as Record<string, unknown>[]
  return rows.some(row => publishedWireId(row, deviceInstanceId) === wireId)
}

/**
 * Drops from `target`'s retirement queue every wire id that a local row of
 * this device is published under now. The row is pushed under that id, and a
 * tombstone sent after it would delete it from the cloud. A fold retires a
 * copy's wire id that no row publishes, and the parse can move the original
 * onto it right after: a Claude Code record follows its message's last line.
 * Returns the number of ids dropped.
 */
export function unretirePublishedWireIds(db: Database.Database, target: string, deviceInstanceId: string): number {
  const retired = db.prepare('SELECT wire_id FROM sync_retired_wire_ids WHERE target = ?').all(target) as Array<{ wire_id: string }>
  if (retired.length === 0) return 0
  const published = new Set<string>()
  const rows = db.prepare(`
    SELECT * FROM records
    WHERE ${LOCAL_RECORDS_WHERE} AND device_instance_id IN (?, '${UNKNOWN_DEVICE_INSTANCE_ID}')
  `).all(deviceInstanceId) as Record<string, unknown>[]
  for (const row of rows) published.add(publishedWireId(row, deviceInstanceId))
  const drop = db.prepare('DELETE FROM sync_retired_wire_ids WHERE target = ? AND wire_id = ?')
  return db.transaction(() => {
    let dropped = 0
    for (const { wire_id } of retired) {
      if (published.has(wire_id)) dropped += drop.run(target, wire_id).changes
    }
    return dropped
  })()
}

/**
 * Records stored twice, once under the `'unknown'` sentinel's id and once
 * under the device's own, whose ids are built from their source file and
 * line (most JSONL logs: Codex, CodeFuse's embedded Codex, Copilot, OpenClaw,
 * Qoder and the generic logs). Both ids can be rebuilt from the stored
 * columns, so such a copy is proven without reading its source, which may be
 * gone. Each copy is folded into its original (`foldRecordCopy`). Returns the
 * number of copies removed.
 */
export function foldLineSeededRecordCopies(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT id, device_instance_id, source_file, line_offset FROM records
    WHERE ${LOCAL_RECORDS_WHERE} AND device_instance_id != '${UNKNOWN_DEVICE_INSTANCE_ID}'
  `).all() as Array<{ id: string; device_instance_id: string; source_file: string; line_offset: number }>
  const stored = db.prepare(`
    SELECT 1 FROM records
    WHERE id = ? AND ${LOCAL_RECORDS_WHERE} AND device_instance_id IN (?, '${UNKNOWN_DEVICE_INSTANCE_ID}')
  `)
  let folded = 0
  for (const row of rows) {
    if (row.id !== generateRecordId(row.device_instance_id, row.source_file, row.line_offset)) continue
    const originalId = generateRecordId(UNKNOWN_DEVICE_INSTANCE_ID, row.source_file, row.line_offset)
    if (!stored.get(originalId, row.device_instance_id)) continue
    if (foldRecordCopy(db, row.id, originalId)) folded++
  }
  return folded
}

/**
 * The complete, authoritative set of records this device publishes: every
 * locally parsed row stamped with its id. This is what a sync snapshot of the
 * device's remote namespace is built from — never a delta.
 */
export function getLocalRecordsForDevice(db: Database.Database, deviceInstanceId: string): StatsRecord[] {
  const rows = db.prepare(`
    SELECT * FROM records
    WHERE ${LOCAL_RECORDS_WHERE} AND device_instance_id = ?
    ORDER BY ts, id
  `).all(deviceInstanceId) as Record<string, unknown>[]
  return rows.map(mapRowToRecord)
}
