import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { generateRecordId, generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord, Tool } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, insertRecord, markRecordsSynced } from '../../src/db/records.js'
import { DELETED_LOCAL_ROWS } from '../../src/db/sync-claims.js'
import {
  collapseImporterDuplicates,
  deleteCursorTranscriptEstimates,
  kiroLogLineId,
  repairImporterDuplicates,
  replaceKiroLogLines,
  replaceSourceSnapshot,
} from '../../src/commands/importer-duplicates.js'
import { WatermarkManager } from '../../src/watermark.js'

/** The cloud store for one device, with the rules of the server's push route. */
const server = new Map<string, { record: SyncRecord; deleted: boolean }>()
const tombstonesSent: string[] = []
/** Each runs once while a push of that kind is pending, as a parse in another process would. */
let whileUploading: (() => void) | null = null
let whileRetracting: (() => void) | null = null
/** The server accepts the next record push, but the response does not arrive. */
let loseResponse = false
/** The next tombstone push fails before it reaches the server. */
let failRetraction = false
/** Ids whose tombstone the server reports as not applied, once each. */
const refuseTombstones = new Set<string>()

vi.mock('../../src/sync/cloud.js', () => ({
  CloudSyncError: class CloudSyncError extends Error {},
  cloudPull: vi.fn(async () => ({ records: [], tombstones: [], hasMore: false, syncGeneration: 1 })),
  cloudPush: vi.fn(async (records: SyncRecord[], tombstones: Array<{ record_id: string; updatedAt: number }>) => {
    if (records.length > 0 && whileUploading) {
      const run = whileUploading
      whileUploading = null
      run()
    }
    if (tombstones.length > 0 && whileRetracting) {
      const run = whileRetracting
      whileRetracting = null
      run()
    }
    if (tombstones.length > 0 && failRetraction) {
      failRetraction = false
      throw new Error('connection reset')
    }
    for (const record of records) {
      const held = server.get(record.id)
      // A record that exists is replaced only by a newer version.
      if (!held || held.record.updatedAt < record.updatedAt) server.set(record.id, { record, deleted: false })
    }
    const rejectedTombstoneIds: string[] = []
    for (const tombstone of tombstones) {
      tombstonesSent.push(tombstone.record_id)
      if (refuseTombstones.delete(tombstone.record_id)) {
        rejectedTombstoneIds.push(tombstone.record_id)
        continue
      }
      const held = server.get(tombstone.record_id)
      // A tombstone is a version of its own: only a newer record brings the id back.
      if (held) server.set(tombstone.record_id, { record: { ...held.record, updatedAt: tombstone.updatedAt }, deleted: true })
    }
    if (records.length > 0 && loseResponse) {
      loseResponse = false
      throw new Error('socket hang up')
    }
    return { inserted: 0, updated: 0, skipped: 0, rejectedTombstoneIds, syncGeneration: 1 }
  }),
}))

const DEVICE = 'device-a'
const T0 = 1_780_000_000_000
const KIRO_LOG = '/home/me/kiro/tokens_generated.jsonl'
const TRANSCRIPT = '/home/me/.cursor/projects/p/agent-transcripts/c1/c1.jsonl'
const CONVERSATION = '/home/me/CodeBuddyIDE/ws/history/s/conv-1'
const GITHUB = 'github:me/data'

function record(tool: Tool, id: string, sourceFile: string, ts: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id, ts, ingestedAt: ts, updatedAt: ts, lineOffset: 0,
    tool, model: 'm', provider: 'p',
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'unknown', sessionId: 's', sourceFile, device: 'laptop', deviceInstanceId: DEVICE,
    ...overrides,
  }
}

/** A Kiro log line as the old importer stored it: keyed on the file time of the parse that read it. */
const oldKiro = (lineOffset: number, mtime: number) =>
  record('kiro', generateRecordId(DEVICE, `${KIRO_LOG}:${lineOffset}`, mtime), KIRO_LOG, mtime, { lineOffset })

/** A CodeBuddy IDE conversation snapshot as the old importer stored it. */
const oldConversation = (ts: number, input: number, updatedAt: number) =>
  record('codebuddy', generateRecordId(DEVICE, CONVERSATION, ts), CONVERSATION, ts, { inputTokens: input, updatedAt })

describe('importer duplicates and sync targets', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    server.clear()
    tombstonesSent.length = 0
    whileUploading = null
    whileRetracting = null
    loseResponse = false
    failRetraction = false
    refuseTombstones.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    db.close()
  })

  const cloudSync = async () => {
    const { CloudSyncOrchestrator } = await import('../../src/sync/cloud-orchestrator.js')
    return new CloudSyncOrchestrator(db, { deviceInstanceId: DEVICE }).sync()
  }
  const onServer = () => Array.from(server.values()).filter(held => !held.deleted).map(held => held.record)
  /** The retraction queue of the sync targets, without the list of every deleted row. */
  const retired = () => db.prepare(`SELECT target, wire_id FROM sync_retired_wire_ids WHERE target != ? ORDER BY target, wire_id`).all(DELETED_LOCAL_ROWS) as Array<{ target: string; wire_id: string }>
  const stored = (id: string) => db.prepare(`SELECT input_tokens, updated_at FROM records WHERE id = ?`).get(id) as { input_tokens: number; updated_at: number }

  it('retracts the Kiro rows the collapse deletes from the cloud', async () => {
    // Two parses of a two-line log, as the old importer left them.
    const first = [oldKiro(0, T0), oldKiro(80, T0)]
    const second = [oldKiro(0, T0 + 60_000), oldKiro(80, T0 + 60_000)]
    for (const row of [...first, ...second]) insertRecord(db, row)
    expect((await cloudSync()).uploadedCount).toBe(4)
    expect(onServer()).toHaveLength(4)

    expect(collapseImporterDuplicates(db).kiro).toBe(2)
    expect(retired()).toEqual(first.map(row => ({ target: 'cloud', wire_id: row.id })).sort((a, b) => (a.wire_id < b.wire_id ? -1 : 1)))

    const result = await cloudSync()
    expect(result).toMatchObject({ status: 'ok', uploadedCount: 0, retiredCount: 2 })
    expect(onServer().map(r => r.id).sort()).toEqual(second.map(row => row.id).sort())
    expect(retired()).toEqual([])
  })

  it('retracts a row that a parse deletes while its first upload is pending', async () => {
    const first = [oldKiro(0, T0), oldKiro(80, T0)]
    const second = [oldKiro(0, T0 + 60_000), oldKiro(80, T0 + 60_000)]
    for (const row of [...first, ...second]) insertRecord(db, row)
    // Nothing is acknowledged yet when the rows are deleted, and the upload
    // that was read before the delete still delivers all four.
    whileUploading = () => { collapseImporterDuplicates(db) }

    const result = await cloudSync()
    expect(result).toMatchObject({ status: 'ok', uploadedCount: 4, retiredCount: 2 })
    expect(onServer().map(r => r.id).sort()).toEqual(second.map(row => row.id).sort())
    expect(retired()).toEqual([])

    // The list of deleted ids does not outlive the sync that could have uploaded them.
    expect((await cloudSync()).retiredCount).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })

  it('retracts a row deleted during an upload whose response was lost', async () => {
    const first = [oldKiro(0, T0), oldKiro(80, T0)]
    const second = [oldKiro(0, T0 + 60_000), oldKiro(80, T0 + 60_000)]
    for (const row of [...first, ...second]) insertRecord(db, row)
    whileUploading = () => { collapseImporterDuplicates(db) }
    loseResponse = true

    expect((await cloudSync()).status).toBe('failed')
    expect(onServer()).toHaveLength(4)
    expect(retired()).toEqual([])

    expect((await cloudSync()).status).toBe('ok')
    expect(onServer().map(r => r.id).sort()).toEqual(second.map(row => row.id).sort())
  })

  it('keeps a row deleted during an upload listed when the tombstone request fails, and retracts it on the retry', async () => {
    const [deleted, kept] = [oldKiro(0, T0), oldKiro(0, T0 + 60_000)]
    for (const row of [deleted, kept]) insertRecord(db, row)
    // Not acknowledged when it is deleted: only the list of deleted rows has it.
    whileUploading = () => { collapseImporterDuplicates(db) }
    failRetraction = true

    expect((await cloudSync()).status).toBe('failed')
    expect(onServer().map(r => r.id).sort()).toEqual([deleted.id, kept.id].sort())
    expect(retired()).toEqual([])
    expect(db.prepare(`SELECT wire_id FROM sync_retired_wire_ids WHERE target = ?`).pluck().all(DELETED_LOCAL_ROWS)).toEqual([deleted.id])

    expect(await cloudSync()).toMatchObject({ status: 'ok', retiredCount: 1 })
    expect(onServer().map(r => r.id)).toEqual([kept.id])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })

  it('keeps a deleted row queued under both keys while the server does not apply its tombstone, sending it once per sync', async () => {
    const [deleted, kept] = [oldKiro(0, T0), oldKiro(0, T0 + 60_000)]
    for (const row of [deleted, kept]) insertRecord(db, row)
    await cloudSync()
    expect(collapseImporterDuplicates(db).kiro).toBe(1)
    refuseTombstones.add(deleted.id)

    const refused = await cloudSync()
    expect(refused).toMatchObject({ status: 'ok', retiredCount: 0, unretiredCount: 1 })
    expect(tombstonesSent).toEqual([deleted.id])
    expect(retired()).toEqual([{ target: 'cloud', wire_id: deleted.id }])
    expect(db.prepare(`SELECT wire_id FROM sync_retired_wire_ids WHERE target = ?`).pluck().all(DELETED_LOCAL_ROWS)).toEqual([deleted.id])
    expect(onServer().map(r => r.id).sort()).toEqual([deleted.id, kept.id].sort())

    const applied = await cloudSync()
    expect(applied).toMatchObject({ status: 'ok', retiredCount: 1 })
    expect(applied.unretiredCount).toBeUndefined()
    expect(onServer().map(r => r.id)).toEqual([kept.id])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })

  it('forgets a listed id the cloud cannot hold without sending it', async () => {
    const queue = db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)`)
    for (const id of ['gone', 'bad\u0000id', '']) queue.run(DELETED_LOCAL_ROWS, id)

    expect(await cloudSync()).toMatchObject({ status: 'ok', retiredCount: 1 })
    expect(tombstonesSent).toEqual(['gone'])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })

  it('sends a tombstone that changes nothing for a row that was deleted before it was uploaded', async () => {
    const [deleted, kept] = [oldKiro(0, T0), oldKiro(0, T0 + 60_000)]
    for (const row of [deleted, kept]) insertRecord(db, row)
    expect(collapseImporterDuplicates(db).kiro).toBe(1)
    expect(retired()).toEqual([])

    expect((await cloudSync()).status).toBe('ok')
    expect(tombstonesSent).toEqual([deleted.id])
    expect(onServer().map(r => r.id)).toEqual([kept.id])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })

  it('does not send a tombstone for an id that is stored again while an earlier batch is pending', async () => {
    const restored = record('kiro', kiroLogLineId(DEVICE, KIRO_LOG, 0, 'line'), KIRO_LOG, T0, { updatedAt: Date.now() })
    const queue = db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES ('cloud', ?)`)
    // More than one batch of ids that sort before the record's.
    for (let i = 0; i < 500; i++) queue.run(`!${String(i).padStart(3, '0')}`)
    queue.run(restored.id)
    whileRetracting = () => { replaceKiroLogLines(db, KIRO_LOG, [restored]) }

    expect((await cloudSync()).status).toBe('ok')
    expect(tombstonesSent).toHaveLength(500)
    expect(tombstonesSent).not.toContain(restored.id)
    expect((await cloudSync()).uploadedCount).toBe(1)
    expect(onServer().map(r => r.id)).toEqual([restored.id])
  })

  it('queues a deleted row only for the targets that acknowledged it', () => {
    const [onBoth, onGithub, nowhere, kept] = [oldKiro(0, T0), oldKiro(0, T0 + 1), oldKiro(0, T0 + 2), oldKiro(0, T0 + 3)]
    for (const row of [onBoth, onGithub, nowhere, kept]) insertRecord(db, row)
    markRecordsSynced(db, [onBoth.id, kept.id], T0 + 9, 'cloud')
    markRecordsSynced(db, [onBoth.id, onGithub.id], T0 + 9, GITHUB)

    expect(collapseImporterDuplicates(db).kiro).toBe(3)
    expect(retired()).toHaveLength(3)
    expect(retired()).toEqual(expect.arrayContaining([
      { target: 'cloud', wire_id: onBoth.id },
      { target: GITHUB, wire_id: onBoth.id },
      { target: GITHUB, wire_id: onGithub.id },
    ]))
  })

  it('retracts the Cursor estimates deleted for a conversation that is counted from state.vscdb', () => {
    const estimate = record('cursor', generateRecordId(DEVICE, TRANSCRIPT, 0), TRANSCRIPT, T0)
    const other = record('cursor', 'other-estimate', TRANSCRIPT.replace(/c1/g, 'c2'), T0)
    for (const row of [estimate, other]) insertRecord(db, row)
    markRecordsSynced(db, [estimate.id, other.id], T0 + 9, 'cloud')

    expect(deleteCursorTranscriptEstimates(db, ['c1'])).toBe(1)
    expect(retired()).toEqual([{ target: 'cloud', wire_id: estimate.id }])
  })

  it('still retracts an estimate that was stored again since its last upload', async () => {
    const estimate = record('cursor', generateRecordId(DEVICE, TRANSCRIPT, 0), TRANSCRIPT, T0)
    insertRecord(db, estimate)
    await cloudSync()

    // The transcript grew, and state.vscdb delivered the conversation's token counts
    // in the same parse. The clock of that parse is not ahead of the stored version.
    expect(replaceSourceSnapshot(db, 'cursor', TRANSCRIPT, { ...estimate, inputTokens: 300 }, 'larger')).toBe(true)
    expect(getUnsyncedRecords(db, 'cloud', DEVICE).map(r => r.id)).toEqual([estimate.id])
    expect(deleteCursorTranscriptEstimates(db, ['c1'])).toBe(1)
    expect(retired()).toEqual([{ target: 'cloud', wire_id: estimate.id }])

    await cloudSync()
    expect(onServer()).toEqual([])
  })

  it('does not retract a CodeBuddy wire id when the row deleted is the one stored under the new id', async () => {
    // The new id of a conversation is also the wire id of all its snapshots.
    const stable = record('codebuddy', generateRecordId(DEVICE, CONVERSATION, 0), CONVERSATION, T0, { inputTokens: 1000 })
    insertRecord(db, stable)
    await cloudSync()
    expect(onServer().map(r => r.id)).toEqual([stable.id])

    // An older CLI then imported another turn under its time-based id and
    // rewrote watermark.json without the repair version, so the repair runs again.
    const later = oldConversation(T0 + 60_000, 2500, T0 + 60_000)
    insertRecord(db, later)
    expect(collapseImporterDuplicates(db).codebuddy).toBe(1)
    expect(db.prepare(`SELECT id FROM records`).all()).toEqual([{ id: later.id }])
    expect(retired()).toEqual([])

    await cloudSync()
    expect(tombstonesSent).toEqual([])
    expect(onServer().map(r => [r.id, r.inputTokens])).toEqual([[stable.id, 2500]])
  })

  it('publishes the CodeBuddy snapshot the collapse keeps as the newest version of its wire id', async () => {
    // The latest snapshot was stored first; a later import that could only
    // read an older message stored an earlier snapshot with a newer version.
    const latest = oldConversation(T0 + 60_000, 2500, T0 + 60_000)
    const earlier = oldConversation(T0, 1000, T0 + 120_000)
    for (const row of [latest, earlier]) insertRecord(db, row)
    const wire = generateSyncRecordId(DEVICE, CONVERSATION, 0)
    await cloudSync()
    expect(onServer().map(r => [r.id, r.inputTokens])).toEqual([[wire, 1000]])

    expect(collapseImporterDuplicates(db).codebuddy).toBe(1)
    // The kept row takes the wire id over, so the id is not retired.
    expect(retired()).toEqual([])
    expect(stored(latest.id).input_tokens).toBe(2500)
    expect(stored(latest.id).updated_at).toBeGreaterThan(earlier.updatedAt)

    const result = await cloudSync()
    expect(result).toMatchObject({ status: 'ok', uploadedCount: 1, retiredCount: 0 })
    expect(tombstonesSent).toEqual([])
    expect(onServer().map(r => [r.id, r.inputTokens])).toEqual([[wire, 2500]])
  })

  it('leaves the version of a kept CodeBuddy snapshot alone when it is the newest already', () => {
    const earlier = oldConversation(T0, 1000, T0)
    const latest = oldConversation(T0 + 60_000, 2500, T0 + 60_000)
    for (const row of [earlier, latest]) insertRecord(db, row)
    markRecordsSynced(db, [earlier.id, latest.id], T0 + 60_000, 'cloud')

    expect(collapseImporterDuplicates(db).codebuddy).toBe(1)
    expect(stored(latest.id).updated_at).toBe(T0 + 60_000)
    expect(retired()).toEqual([])
  })

  it('does not retract a CodeBuddy conversation that is imported again under its new id', async () => {
    const old = oldConversation(T0, 1000, T0 + 500)
    insertRecord(db, old)
    const wire = generateSyncRecordId(DEVICE, CONVERSATION, 0)
    await cloudSync()

    // The clock of the parse that reads it again is behind the stored version.
    const next = record('codebuddy', generateRecordId(DEVICE, CONVERSATION, 0), CONVERSATION, T0 + 60_000, { inputTokens: 2500, updatedAt: T0 + 100 })
    expect(replaceSourceSnapshot(db, 'codebuddy', CONVERSATION, next, 'later')).toBe(true)
    expect(retired()).toEqual([])
    expect(stored(next.id).updated_at).toBeGreaterThan(old.updatedAt)

    await cloudSync()
    expect(tombstonesSent).toEqual([])
    expect(onServer().map(r => [r.id, r.inputTokens])).toEqual([[wire, 2500]])
  })

  it('stores a record that replaces a row of the same id as a newer version, whatever the clock says', async () => {
    const id = generateRecordId(DEVICE, CONVERSATION, 0)
    // The stored version is ahead of this parse's clock.
    const ahead = Date.now() + 3_600_000
    insertRecord(db, record('codebuddy', id, CONVERSATION, T0, { inputTokens: 1000, updatedAt: ahead }))
    await cloudSync()

    const next = record('codebuddy', id, CONVERSATION, T0 + 60_000, { inputTokens: 2500, updatedAt: Date.now() })
    expect(replaceSourceSnapshot(db, 'codebuddy', CONVERSATION, next, 'later')).toBe(true)
    expect(stored(id).updated_at).toBeGreaterThan(ahead)
    expect(getUnsyncedRecords(db, 'cloud', DEVICE).map(r => r.id)).toEqual([id])

    await cloudSync()
    expect(onServer().map(r => [r.id, r.inputTokens])).toEqual([[id, 2500]])
  })

  it('takes a wire id off the retraction queue when a record is stored under it again', async () => {
    const line = (text: string) => record('kiro', kiroLogLineId(DEVICE, KIRO_LOG, 0, text), KIRO_LOG, T0, { updatedAt: Date.now() })
    const original = line('first log')
    replaceKiroLogLines(db, KIRO_LOG, [original])
    await cloudSync()

    // The log is replaced by one whose first request has the same model and
    // token counts, then the first log comes back, all before the next sync.
    replaceKiroLogLines(db, KIRO_LOG, [line('second log')])
    expect(retired()).toEqual([{ target: 'cloud', wire_id: original.id }])
    replaceKiroLogLines(db, KIRO_LOG, [line('first log')])
    // The second log's row was never uploaded, so it leaves nothing to retract.
    expect(retired()).toEqual([])

    await cloudSync()
    expect(onServer().map(r => r.id)).toEqual([original.id])
  })

  it('does not retract a row that an older CLI stored again before the repair ran a second time', async () => {
    const [first, second] = [oldKiro(0, T0), oldKiro(0, T0 + 60_000)]
    for (const row of [first, second]) insertRecord(db, row)
    await cloudSync()
    // tests/setup-home.ts gives this file its own home directory.
    const watermarkPath = join(homedir(), 'watermark.json')
    writeFileSync(watermarkPath, JSON.stringify({ files: {} }))
    expect(repairImporterDuplicates(db, new WatermarkManager(watermarkPath))?.kiro).toBe(1)
    expect(retired()).toEqual([{ target: 'cloud', wire_id: first.id }])

    // Before the next sync an older CLI reads a restored copy of the log with
    // the first file time, which stores the deleted row again under its id,
    // and saves watermark.json without the repair version. Then the log is gone.
    insertRecord(db, { ...first, updatedAt: Date.now() })
    writeFileSync(watermarkPath, JSON.stringify({ files: {} }))
    // The repair runs again and keeps the row written last; no importer reads the source again.
    expect(repairImporterDuplicates(db, new WatermarkManager(watermarkPath))?.kiro).toBe(1)
    expect(db.prepare(`SELECT id FROM records`).all()).toEqual([{ id: first.id }])

    expect(await cloudSync()).toMatchObject({ status: 'ok', uploadedCount: 1, retiredCount: 1 })
    expect(tombstonesSent).toEqual([second.id])
    expect(onServer().map(r => r.id)).toEqual([first.id])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids WHERE target IN ('cloud', ?)`).get(DELETED_LOCAL_ROWS)).toEqual({ n: 0 })

    expect(await cloudSync()).toMatchObject({ uploadedCount: 0, retiredCount: 0 })
    expect(onServer().map(r => r.id)).toEqual([first.id])
  })

  it('does not retract a queued wire id that a local Cursor or CodeBuddy row is published under', async () => {
    // Rows an older CLI stored again under ids the repair had deleted and queued.
    const estimate = record('cursor', generateRecordId(DEVICE, TRANSCRIPT, T0), TRANSCRIPT, T0)
    const snapshot = oldConversation(T0, 1000, T0)
    const wire = generateSyncRecordId(DEVICE, CONVERSATION, 0)
    for (const row of [estimate, snapshot]) insertRecord(db, row)
    const queue = db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)`)
    for (const target of ['cloud', DELETED_LOCAL_ROWS]) {
      for (const id of [estimate.id, wire, 'gone']) queue.run(target, id)
    }

    expect(await cloudSync()).toMatchObject({ status: 'ok', uploadedCount: 2, retiredCount: 1 })
    expect(tombstonesSent).toEqual(['gone'])
    expect(onServer().map(r => r.id).sort()).toEqual([estimate.id, wire].sort())
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_retired_wire_ids`).get()).toEqual({ n: 0 })
  })
})
