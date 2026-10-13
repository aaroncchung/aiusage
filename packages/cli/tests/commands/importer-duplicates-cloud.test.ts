import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId, generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord, Tool } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, markRecordsSynced } from '../../src/db/records.js'
import {
  collapseImporterDuplicates,
  deleteCursorTranscriptEstimates,
  kiroLogLineId,
  replaceKiroLogLines,
  replaceSourceSnapshot,
} from '../../src/commands/importer-duplicates.js'

/** The cloud store for one device, with the rules of the server's push route. */
const server = new Map<string, { record: SyncRecord; deleted: boolean }>()
const tombstonesSent: string[] = []

vi.mock('../../src/sync/cloud.js', () => ({
  CloudSyncError: class CloudSyncError extends Error {},
  cloudPull: vi.fn(async () => ({ records: [], tombstones: [], hasMore: false, syncGeneration: 1 })),
  cloudPush: vi.fn(async (records: SyncRecord[], tombstones: Array<{ record_id: string }>) => {
    for (const record of records) {
      const held = server.get(record.id)
      // A record that exists is replaced only by a newer version.
      if (!held || held.record.updatedAt < record.updatedAt) server.set(record.id, { record, deleted: false })
    }
    for (const tombstone of tombstones) {
      tombstonesSent.push(tombstone.record_id)
      const held = server.get(tombstone.record_id)
      if (held) held.deleted = true
    }
    return { inserted: 0, updated: 0, skipped: 0, syncGeneration: 1 }
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
  const retired = () => db.prepare(`SELECT target, wire_id FROM sync_retired_wire_ids ORDER BY target, wire_id`).all() as Array<{ target: string; wire_id: string }>
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
})
