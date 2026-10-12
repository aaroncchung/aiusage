import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { generateRecordId, type StatsRecord, type Tool } from '@aiusage/core'
import { insertRecord, LOCAL_RECORDS_WHERE, UNKNOWN_DEVICE_INSTANCE_ID } from '../db/records.js'
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
 * Their ids are now stable (file and byte offset for Kiro, the file or the
 * conversation directory for the other two). This module removes the rows the
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

/**
 * Delete locally parsed records by id; rows pulled from other devices are
 * never touched. Tool calls and per-target sync state go with the row
 * (`ON DELETE CASCADE`). Returns the number of rows deleted.
 *
 * What a sync target makes of it: a file-based target (GitHub, S3) publishes
 * this device's namespace as a snapshot of its local records, so the row is
 * gone from it after the next sync and peers prune their copy. The cloud
 * target only ever upserts what it is sent and deletes on an explicit
 * retraction (`sync_retired_wire_ids`); none is queued here, so a row that
 * was already uploaded stays on the server.
 */
export function deleteLocalRecords(db: Database.Database, ids: Iterable<string>): number {
  const del = db.prepare(`DELETE FROM records WHERE id = ? AND ${LOCAL_RECORDS_WHERE}`)
  return db.transaction(() => {
    let deleted = 0
    for (const id of ids) deleted += del.run(id).changes
    return deleted
  })()
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
 * transaction. With no record, the source's rows are simply removed.
 */
export function replaceSourceRecords(db: Database.Database, tool: Tool, sourceFile: string, records: StatsRecord[]): void {
  const keep = new Set(records.map(record => record.id))
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id FROM records WHERE tool = ? AND source_file = ? AND ${LOCAL_RECORDS_WHERE}`,
    ).all(tool, sourceFile) as Array<{ id: string }>
    deleteLocalRecords(db, existing.map(row => row.id).filter(id => !keep.has(id)))
    for (const record of records) insertRecord(db, record)
  })()
}

/**
 * Store the one record that describes a whole source as of `record.ts`
 * (a CodeBuddy IDE conversation's cumulative snapshot), replacing the
 * source's other rows. Nothing is stored or deleted when a row of the source
 * is newer than the record: a conversation whose latest message cannot be
 * read at the moment yields an earlier snapshot, which must not replace the
 * later one. Returns whether the record was stored.
 */
export function replaceSourceSnapshot(db: Database.Database, tool: Tool, sourceFile: string, record: StatsRecord): boolean {
  return db.transaction(() => {
    const newer = db.prepare(
      `SELECT 1 FROM records WHERE tool = ? AND source_file = ? AND ${LOCAL_RECORDS_WHERE} AND ts > ? LIMIT 1`,
    ).get(tool, sourceFile, record.ts)
    if (newer) return false
    replaceSourceRecords(db, tool, sourceFile, [record])
    return true
  })()
}

interface KiroLogRow {
  id: string
  device_instance_id: string
  source_file: string
  line_offset: number
  ts: number
}

/**
 * How much a Kiro log row's id is worth keeping: 2 for the id built from its
 * file and byte offset, 1 for that id built before `init` gave the device an
 * id (the row was relabelled afterwards, its id was not), 0 for an old,
 * time-based id.
 */
function offsetIdRank(row: KiroLogRow): number {
  if (row.id === generateRecordId(row.device_instance_id, row.source_file, row.line_offset)) return 2
  if (row.id === generateRecordId(UNKNOWN_DEVICE_INSTANCE_ID, row.source_file, row.line_offset)) return 1
  return 0
}

/**
 * Store the lines just read from a Kiro token log. Each record replaces every
 * other local row of the same file and byte offset in the same transaction:
 * the copies the old, time-based ids left of that line, and the row a line
 * got before `init` gave the device an id. Rows at other offsets are not
 * touched, so a line that could not be read again keeps what was stored for
 * it.
 */
export function replaceKiroLogLines(db: Database.Database, sourceFile: string, records: StatsRecord[]): void {
  const others = db.prepare(`
    SELECT id FROM records
    WHERE tool = 'kiro' AND ${LOCAL_RECORDS_WHERE} AND source_file = ? AND line_offset = ? AND id != ?
  `)
  db.transaction(() => {
    for (const record of records) {
      const rows = others.all(sourceFile, record.lineOffset, record.id) as Array<{ id: string }>
      deleteLocalRecords(db, rows.map(row => row.id))
      insertRecord(db, record)
    }
  })()
}

/** True when `composerId` has a local record imported from Cursor's `state.vscdb`, which holds real token counts. */
export function hasCursorDatabaseRecord(db: Database.Database, composerId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM records
    WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND session_id = ?
      AND source_file NOT LIKE '%agent-transcripts%'
    LIMIT 1
  `).get(composerId) !== undefined
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

interface SnapshotRow {
  id: string
  source_file: string
  ts: number
  updated_at: number
}

/** All but the newest row of each source: the newest holds the latest state of the whole source. */
function supersededSnapshots(rows: SnapshotRow[]): string[] {
  const newest = new Map<string, SnapshotRow>()
  for (const row of rows) {
    const best = newest.get(row.source_file)
    if (!best || row.ts > best.ts
      || (row.ts === best.ts && (row.updated_at > best.updated_at || (row.updated_at === best.updated_at && row.id > best.id)))) {
      newest.set(row.source_file, row)
    }
  }
  return rows.filter(row => newest.get(row.source_file) !== row).map(row => row.id)
}

/**
 * Reduce the rows the old ids left behind to one copy of each source, from
 * the database alone, so it also works for a source that no longer exists on
 * disk:
 *
 *  - Kiro token logs: every parse stored the lines of the file again, each
 *    under its byte offset and that parse's modification time. One row is
 *    kept per file and offset: the one with an offset-based id if there is
 *    one, otherwise the newest. Lines are matched one by one because a parse
 *    wrote its rows one at a time and may not have stored all of them.
 *  - Cursor transcripts and CodeBuddy IDE conversations: each row describes
 *    the whole source, so the newest one is kept. A transcript estimate goes
 *    altogether when its conversation is counted from `state.vscdb`.
 *
 * Only locally parsed rows are considered. Running it again finds nothing
 * more to delete. Returns the rows deleted per tool.
 */
export function collapseImporterDuplicates(db: Database.Database): ImporterDuplicateCounts {
  return db.transaction(() => {
    const kiroRows = (db.prepare(`
      SELECT id, device_instance_id, source_file, line_offset, ts FROM records
      WHERE tool = 'kiro' AND ${LOCAL_RECORDS_WHERE} AND source_file LIKE '%.jsonl'
    `).all() as KiroLogRow[]).filter(row => isKiroTokenLog(row.source_file))
    const kept = new Map<string, { row: KiroLogRow; rank: number }>()
    for (const row of kiroRows) {
      const key = `${row.source_file}\0${row.line_offset}`
      const rank = offsetIdRank(row)
      const best = kept.get(key)
      if (!best || rank > best.rank
        || (rank === best.rank && (row.ts > best.row.ts || (row.ts === best.row.ts && row.id > best.row.id)))) {
        kept.set(key, { row, rank })
      }
    }
    const kiro = deleteLocalRecords(db, kiroRows
      .filter(row => kept.get(`${row.source_file}\0${row.line_offset}`)!.row !== row)
      .map(row => row.id))

    const transcripts = (db.prepare(`
      SELECT id, source_file, ts, updated_at FROM records
      WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND source_file LIKE '%agent-transcripts%'
    `).all() as SnapshotRow[]).filter(row => isCursorTranscript(row.source_file))
    // An estimate is also superseded when its conversation has a record from
    // state.vscdb: the importer drops it when it reads the transcript, and
    // this covers a transcript that is gone.
    const counted = db.prepare(`
      SELECT DISTINCT session_id FROM records
      WHERE tool = 'cursor' AND ${LOCAL_RECORDS_WHERE} AND source_file NOT LIKE '%agent-transcripts%'
    `).all() as Array<{ session_id: string }>
    const cursor = deleteLocalRecords(db, supersededSnapshots(transcripts))
      + deleteCursorTranscriptEstimates(db, counted.map(row => row.session_id))

    // CodeBuddy IDE rows are keyed on a conversation directory and offset 0;
    // the CodeBuddy CLI's rows come from `*.jsonl` files, one per line.
    const conversations = db.prepare(`
      SELECT id, source_file, ts, updated_at FROM records
      WHERE tool = 'codebuddy' AND ${LOCAL_RECORDS_WHERE} AND line_offset = 0 AND source_file NOT LIKE '%.jsonl'
    `).all() as SnapshotRow[]
    const codebuddy = deleteLocalRecords(db, supersededSnapshots(conversations))

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
