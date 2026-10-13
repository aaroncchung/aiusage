import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { generateRecordId, type StatsRecord, type Tool } from '@aiusage/core'
import { getRecordById, getRecordsBySourceFile, insertRecord, LOCAL_RECORDS_WHERE } from '../db/records.js'
import { mapStatsRecordToSyncRecord } from '../sync/mapper.js'
import { CURRENT_IMPORTER_DEDUP_VERSION, type WatermarkManager } from '../watermark.js'

/**
 * Three importers used to store a source again under a new id every time it
 * changed, leaving the earlier rows in place (issues #79, #80, #81):
 *
 *  - Kiro token logs (`*.jsonl`): every line of the file, keyed on the file's
 *    modification time, on each parse.
 *  - Cursor agent transcripts: one estimate of the whole file, keyed on the
 *    modification time.
 *  - CodeBuddy IDE conversations: one conversation-cumulative snapshot, keyed
 *    on the time of the latest message.
 *
 * Their ids are now stable (file, byte offset and line for Kiro, the file or
 * the conversation directory for the other two). This module removes the rows the
 * old ids left behind, once for the whole database and whenever a source is
 * imported again.
 */

/** A Kiro file imported line by line (`tokens_generated.jsonl`), as `runParse` selects it. */
export function isKiroTokenLog(filePath: string): boolean {
  return filePath.endsWith('.jsonl')
}

/** A Cursor agent transcript, as `runParse` selects it. */
export function isCursorTranscript(filePath: string): boolean {
  return filePath.endsWith('.jsonl') && filePath.includes('agent-transcripts')
}

/** The composer (conversation) a transcript belongs to: `agent-transcripts/<id>/<id>.jsonl`. */
export function cursorTranscriptComposerId(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
}

/** The id a local record is published under on every sync target. */
function wireId(record: StatsRecord): string {
  return mapStatsRecordToSyncRecord(record).id
}

/**
 * Delete locally parsed records by id; rows pulled from other devices are
 * never touched. Tool calls and per-target sync state go with the row
 * (`ON DELETE CASCADE`). Returns the number of rows deleted.
 *
 * A deleted row may already be published, under its wire id, on the targets
 * that acknowledged it (`sync_record_state`). What becomes of that copy
 * depends on whether a local row is left that travels under the same wire id,
 * which is looked up once every row of the call is gone:
 *
 *  - None is left (Kiro and Cursor rows, whose wire id is their own id): the
 *    wire id is queued in `sync_retired_wire_ids` for each of those targets,
 *    before the transaction ends. The cloud target is upsert-only and deletes
 *    the copy when it is sent the queue as tombstones; a file-based target
 *    (GitHub, S3) publishes this device's namespace as a snapshot of its
 *    local records, so the copy is gone with the next sync anyway and the
 *    queue entry is cleared unused. Nothing is queued for a target that never
 *    acknowledged the row.
 *  - One is left (CodeBuddy IDE snapshots of one conversation share a wire
 *    id): retiring the id would delete the row that stands for it now, so
 *    nothing is queued. The remaining row is the correction of the deleted
 *    one, and targets and peers take a payload only when its `updatedAt` is
 *    greater than the one they hold, so its `updated_at` is moved past the
 *    deleted row's, which also makes it count as unsynced again.
 */
export function deleteLocalRecords(db: Database.Database, ids: Iterable<string>): number {
  const targetsOf = db.prepare(`SELECT target FROM sync_record_state WHERE record_id = ?`).pluck()
  const del = db.prepare(`DELETE FROM records WHERE id = ? AND ${LOCAL_RECORDS_WHERE}`)
  const retire = db.prepare(`INSERT OR IGNORE INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)`)
  const advance = db.prepare(`UPDATE records SET updated_at = ? WHERE id = ? AND updated_at <= ?`)
  return db.transaction(() => {
    const deleted: Array<{ record: StatsRecord; targets: string[] }> = []
    for (const id of ids) {
      const record = getRecordById(db, id)
      if (!record || record.origin !== 'local') continue
      const targets = targetsOf.all(id) as string[]
      if (del.run(id).changes > 0) deleted.push({ record, targets })
    }
    for (const { record, targets } of deleted) {
      const published = wireId(record)
      // A wire id that is the row's own id went with the row; any other is
      // derived from the source, so only rows of the source can share it.
      const heirs = published === record.id ? [] : getRecordsBySourceFile(db, record.sourceFile)
        .filter(other => other.origin === 'local' && wireId(other) === published)
      if (heirs.length === 0) {
        for (const target of targets) retire.run(target, published)
        continue
      }
      for (const heir of heirs) advance.run(Math.max(Date.now(), record.updatedAt + 1), heir.id, record.updatedAt)
    }
    return deleted.length
  })()
}

/**
 * Store records this module may have deleted before under the same wire id.
 * A wire id still waiting in `sync_retired_wire_ids` is taken off the queue:
 * the cloud target sends the queue after the records, so the retraction would
 * delete the record just stored.
 */
function storeRecords(db: Database.Database, records: StatsRecord[]): void {
  for (const record of records) insertRecord(db, record)
  if (records.length === 0) return
  const targets = db.prepare(`SELECT DISTINCT target FROM sync_retired_wire_ids`).pluck().all() as string[]
  if (targets.length === 0) return
  const unretire = db.prepare(`DELETE FROM sync_retired_wire_ids WHERE target = ? AND wire_id = ?`)
  for (const record of records) {
    for (const target of targets) unretire.run(target, wireId(record))
  }
}

/**
 * Fingerprint of the first `length` bytes of a file. An append-only log keeps
 * the part that was already read, so a different fingerprint for it means the
 * file was replaced or rewritten. Null when the file is shorter than that.
 */
export function prefixFingerprint(buffer: Buffer, length: number): string | null {
  if (length > buffer.length) return null
  return createHash('sha256').update(buffer.subarray(0, length)).digest('hex').slice(0, 32)
}

/**
 * Store `records` as everything this device knows about `sourceFile`: local
 * rows of the same tool and source under any other id are deleted in the same
 * transaction. With no record, the source's rows are simply removed. The
 * records are stored first, so a deleted row whose wire id one of them takes
 * over is not retracted from the sync targets (see `deleteLocalRecords`).
 */
export function replaceSourceRecords(db: Database.Database, tool: Tool, sourceFile: string, records: StatsRecord[]): void {
  const keep = new Set(records.map(record => record.id))
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id FROM records WHERE tool = ? AND source_file = ? AND ${LOCAL_RECORDS_WHERE}`,
    ).all(tool, sourceFile) as Array<{ id: string }>
    storeRecords(db, records)
    deleteLocalRecords(db, existing.map(row => row.id).filter(id => !keep.has(id)))
  })()
}

/**
 * Store the one record that describes a whole source — a CodeBuddy IDE
 * conversation's cumulative snapshot, a Cursor transcript's estimate —
 * replacing the source's other rows. Nothing is stored or deleted when a row
 * of the source holds more than the record does, which happens when part of
 * the source cannot be read at the moment:
 *
 *  - `'later'`: a stored row is newer (`ts`). A conversation whose latest
 *    message is unreadable yields an earlier snapshot.
 *  - `'larger'`: a stored row counts more input or more output tokens. A
 *    transcript only grows, so an estimate that is smaller in either
 *    direction means lines of it could not be parsed.
 *
 * Returns whether the record was stored.
 */
export function replaceSourceSnapshot(
  db: Database.Database,
  tool: Tool,
  sourceFile: string,
  record: StatsRecord,
  keepStored: 'later' | 'larger',
): boolean {
  return db.transaction(() => {
    const better = keepStored === 'later'
      ? db.prepare(
          `SELECT 1 FROM records WHERE tool = ? AND source_file = ? AND ${LOCAL_RECORDS_WHERE} AND ts > ? LIMIT 1`,
        ).get(tool, sourceFile, record.ts)
      : db.prepare(
          `SELECT 1 FROM records WHERE tool = ? AND source_file = ? AND ${LOCAL_RECORDS_WHERE} AND (input_tokens > ? OR output_tokens > ?) LIMIT 1`,
        ).get(tool, sourceFile, record.inputTokens, record.outputTokens)
    if (better) return false
    replaceSourceRecords(db, tool, sourceFile, [record])
    return true
  })()
}

/**
 * Id of one line of a Kiro token log: the file, the byte offset and the line
 * itself. The offset makes a line read again replace its own record; the
 * line's content keeps a different request apart that sits at the same
 * offset after the log was replaced by a new one.
 */
export function kiroLogLineId(deviceInstanceId: string, filePath: string, lineOffset: number, line: string): string {
  const lineHash = createHash('sha256').update(line).digest('hex').slice(0, 16)
  return generateRecordId(deviceInstanceId, `${filePath}:${lineHash}`, lineOffset)
}

/**
 * Store the lines just read from a Kiro token log. Each record replaces the
 * other local rows that stand for the same request — same file, byte offset,
 * model and token counts — in the same transaction: the copies the old,
 * time-based ids left of that line, and the row a line got before `init`
 * gave the device an id. Nothing else is touched, so a line that could not be
 * read again keeps what was stored for it, and so does a request of an
 * earlier log that happened to sit at the same offset.
 */
export function replaceKiroLogLines(db: Database.Database, sourceFile: string, records: StatsRecord[]): void {
  if (records.length === 0) return
  const request = (lineOffset: number, model: string, inputTokens: number, outputTokens: number) =>
    [lineOffset, model, inputTokens, outputTokens].join('\0')
  db.transaction(() => {
    // The source's rows are read once, not once per line.
    const stored = db.prepare(`
      SELECT id, line_offset, model, input_tokens, output_tokens FROM records
      WHERE tool = 'kiro' AND ${LOCAL_RECORDS_WHERE} AND source_file = ?
    `).all(sourceFile) as Array<{ id: string; line_offset: number; model: string; input_tokens: number; output_tokens: number }>
    const byRequest = new Map<string, string[]>()
    for (const row of stored) {
      const key = request(row.line_offset, row.model, row.input_tokens, row.output_tokens)
      const ids = byRequest.get(key)
      if (ids) ids.push(row.id)
      else byRequest.set(key, [row.id])
    }
    deleteLocalRecords(db, records.flatMap(record =>
      (byRequest.get(request(record.lineOffset, record.model, record.inputTokens, record.outputTokens)) ?? [])
        .filter(id => id !== record.id)))
    storeRecords(db, records)
  })()
}

/** Session ids of the local records imported from Cursor's `state.vscdb`, which holds real token counts. */
function cursorDatabaseComposers(db: Database.Database, composerId?: string): Set<string> {
  const rows = (composerId === undefined
    ? db.prepare(`SELECT session_id, source_file FROM records WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE}`).all()
    : db.prepare(`SELECT session_id, source_file FROM records WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND session_id = ?`).all(composerId)
  ) as Array<{ session_id: string; source_file: string }>
  // Everything the Cursor importers store that is not a transcript estimate comes from the database.
  return new Set(rows.filter(row => !isCursorTranscript(row.source_file)).map(row => row.session_id))
}

/** True when `composerId` has a local record imported from Cursor's `state.vscdb`. */
export function hasCursorDatabaseRecord(db: Database.Database, composerId: string): boolean {
  return cursorDatabaseComposers(db, composerId).has(composerId)
}

/**
 * Delete the transcript estimates of conversations that `state.vscdb` has
 * just delivered token counts for. A transcript is read before the database
 * within one parse, and a conversation can be estimated before Cursor has
 * written its token counts, so the estimate may already be stored when the
 * real record arrives. Returns the number of rows deleted.
 */
export function deleteCursorTranscriptEstimates(db: Database.Database, composerIds: Iterable<string>): number {
  const composers = new Set(composerIds)
  if (composers.size === 0) return 0
  const rows = db.prepare(`
    SELECT id, source_file FROM records
    WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND source_file LIKE '%agent-transcripts%'
  `).all() as Array<{ id: string; source_file: string }>
  return deleteLocalRecords(db, rows
    .filter(row => isCursorTranscript(row.source_file) && composers.has(cursorTranscriptComposerId(row.source_file)))
    .map(row => row.id))
}

export interface ImporterDuplicateCounts {
  kiro: number
  cursor: number
  codebuddy: number
}

interface DuplicateRow {
  id: string
  source_file: string
  line_offset: number
  model: string
  input_tokens: number
  output_tokens: number
  ts: number
  updated_at: number
}

const DUPLICATE_COLUMNS = 'id, source_file, line_offset, model, input_tokens, output_tokens, ts, updated_at'

/**
 * The ids of all rows but one per group. `key` names the group a row belongs
 * to and `prefer(a, b)` is positive when `a` is the better row to keep; ties
 * go to the greater id so the outcome does not depend on row order.
 */
function allButBest(rows: DuplicateRow[], key: (row: DuplicateRow) => string, prefer: (a: DuplicateRow, b: DuplicateRow) => number): string[] {
  const best = new Map<string, DuplicateRow>()
  for (const row of rows) {
    const current = best.get(key(row))
    if (!current || prefer(row, current) > 0 || (prefer(row, current) === 0 && row.id > current.id)) best.set(key(row), row)
  }
  return rows.filter(row => best.get(key(row)) !== row).map(row => row.id)
}

/**
 * The estimates of each Cursor transcript except the one to keep. A
 * transcript only grows, so a complete estimate is at least as large as every
 * earlier one in input and in output: the newest row that is, is kept. When
 * no row covers the others (every later parse missed lines an earlier one
 * read), no row is complete and the one with the largest total is kept.
 */
function supersededEstimates(rows: DuplicateRow[]): string[] {
  const bySource = new Map<string, DuplicateRow[]>()
  for (const row of rows) {
    const group = bySource.get(row.source_file)
    if (group) group.push(row)
    else bySource.set(row.source_file, [row])
  }
  const superseded: string[] = []
  const newest = (a: DuplicateRow, b: DuplicateRow) => a.ts - b.ts || a.updated_at - b.updated_at
  for (const group of bySource.values()) {
    const maxInput = Math.max(...group.map(row => row.input_tokens))
    const maxOutput = Math.max(...group.map(row => row.output_tokens))
    const covering = group.filter(row => row.input_tokens === maxInput && row.output_tokens === maxOutput)
    superseded.push(...(covering.length > 0
      ? allButBest(group, () => '', (a, b) => Number(covering.includes(a)) - Number(covering.includes(b)) || newest(a, b))
      : allButBest(group, () => '', (a, b) => (a.input_tokens + a.output_tokens) - (b.input_tokens + b.output_tokens) || newest(a, b))))
  }
  return superseded
}

/**
 * Reduce the rows the old ids left behind to one copy each, from the database
 * alone, so it also works for a source that no longer exists on disk:
 *
 *  - Kiro token logs: every parse stored the lines of the file again, each
 *    under its byte offset and that parse's modification time. Rows of one
 *    file that agree in byte offset, model and token counts are copies of one
 *    request, and the most recently written one is kept. Lines are matched
 *    one by one because a parse wrote its rows one at a time and may not have
 *    stored all of them; rows that differ are different requests and stay.
 *  - Cursor transcripts: each row estimates the whole file as far as it could
 *    be parsed, so the estimate that covers the others is kept (see
 *    `supersededEstimates`). None is kept when the conversation is counted
 *    from `state.vscdb`.
 *  - CodeBuddy IDE conversations: each row is a cumulative snapshot, so the
 *    latest one is kept. The snapshots of a conversation share one wire id,
 *    so the kept row is published again as the newest version of it (see
 *    `deleteLocalRecords`).
 *
 * Only locally parsed rows are considered. Running it again finds nothing
 * more to delete. Returns the rows deleted per tool.
 */
export function collapseImporterDuplicates(db: Database.Database): ImporterDuplicateCounts {
  return db.transaction(() => {
    const kiroRows = (db.prepare(`
      SELECT ${DUPLICATE_COLUMNS} FROM records
      WHERE tool = 'kiro' AND ${LOCAL_RECORDS_WHERE} AND source_file LIKE '%.jsonl'
    `).all() as DuplicateRow[]).filter(row => isKiroTokenLog(row.source_file))
    const kiro = deleteLocalRecords(db, allButBest(
      kiroRows,
      row => [row.source_file, row.line_offset, row.model, row.input_tokens, row.output_tokens].join('\0'),
      (a, b) => a.updated_at - b.updated_at || a.ts - b.ts,
    ))

    const transcripts = (db.prepare(`
      SELECT ${DUPLICATE_COLUMNS} FROM records
      WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND source_file LIKE '%agent-transcripts%'
    `).all() as DuplicateRow[]).filter(row => isCursorTranscript(row.source_file))
    // An estimate is also superseded when its conversation has a record from
    // state.vscdb: the importer drops it when it reads the transcript, and
    // this covers a transcript that is gone.
    const cursor = deleteLocalRecords(db, supersededEstimates(transcripts))
      + deleteCursorTranscriptEstimates(db, cursorDatabaseComposers(db))

    // CodeBuddy IDE rows are keyed on a conversation directory and offset 0;
    // the CodeBuddy CLI's rows come from `*.jsonl` files, one per line.
    const conversations = db.prepare(`
      SELECT ${DUPLICATE_COLUMNS} FROM records
      WHERE tool = 'codebuddy' AND ${LOCAL_RECORDS_WHERE} AND line_offset = 0 AND source_file NOT LIKE '%.jsonl'
    `).all() as DuplicateRow[]
    const codebuddy = deleteLocalRecords(db, allButBest(
      conversations,
      row => row.source_file,
      (a, b) => a.ts - b.ts || a.updated_at - b.updated_at,
    ))

    return { kiro, cursor, codebuddy }
  })()
}

/**
 * One-time repair for databases written before the ids became stable, gated
 * by `importerDedupVersion` in `watermark.json`. Returns what was deleted, or
 * null when the repair had already run.
 *
 * The duplicates are collapsed in the database first, which corrects the
 * totals whether or not the sources still exist. Then the three importers are
 * made to read their sources again — the watermark entries of the Kiro logs
 * and Cursor transcripts are dropped and the CodeBuddy IDE cursor is reset —
 * and each importer replaces what is left of a source's old rows as it
 * stores the source under its new id (`replaceKiroLogLines`,
 * `replaceSourceRecords`, `replaceSourceSnapshot`). A source that is gone is
 * never imported again and keeps the one copy the collapse left, and so does
 * a line or a conversation that cannot be read again.
 *
 * The version is written last: if the process stops in between, the next
 * parse runs the repair again, which is harmless.
 */
export function repairImporterDuplicates(db: Database.Database, wm: WatermarkManager): ImporterDuplicateCounts | null {
  if (wm.getImporterDedupVersion() >= CURRENT_IMPORTER_DEDUP_VERSION) return null
  const deleted = collapseImporterDuplicates(db)
  wm.removeEntries('kiro', isKiroTokenLog)
  wm.removeEntries('cursor', isCursorTranscript)
  wm.setCodeBuddyIdeCursor(0)
  wm.setImporterDedupVersion(CURRENT_IMPORTER_DEDUP_VERSION)
  wm.save()
  return deleted
}
