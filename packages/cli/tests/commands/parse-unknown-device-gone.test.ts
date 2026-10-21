import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { generateBlockToolCallId, generateRecordId, generateToolCallId, type StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { applyPragmas } from '../../src/db/schema.js'
import { foldClaudeCodeCopiesOfGoneTranscripts, getUnsyncedRecords, insertRecord } from '../../src/db/records.js'
import { getRetiredWireIds } from '../../src/db/sync-claims.js'
import { migrateV17 } from '../../src/db/migrations/v17.js'
import { runParse } from '../../src/commands/parse.js'
import { buildLocalSnapshot } from '../../src/sync/index.js'

// Claude Code records that v1.5.23 stored twice (once under the id built from
// the 'unknown' device id, once under the device's own), whose transcript was
// deleted before the fix could read it again. Migration v17 folds such a copy
// into its original when both rows sit at the same line of the transcript.
// tests/setup-home.ts gives this file its own home directory.

const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const DEVICE = '11111111-2222-3333-4444-555555555555'
const CLOUD = 'cloud:https://sync.example.test'
const FILE_TARGET = 'github:someone/usage-data'

let db: Database.Database
let src: string
let project: string

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  rmSync(aiusageDir, { recursive: true, force: true })
  mkdirSync(aiusageDir, { recursive: true })
  src = mkdtempSync(join(tmpdir(), 'aiu-gone-'))
  project = join(src, 'proj')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'claude-code': src } }))
  db = new Database(':memory:')
  initializeDatabase(db)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(src, { recursive: true, force: true })
})

type Block = { id: string; name: string; input?: Record<string, unknown> }

function line(messageId: string, ts: string, outputTokens: number, blocks: Block[]): string {
  return JSON.stringify({
    type: 'assistant', cwd: '/work', timestamp: ts,
    message: {
      id: messageId, role: 'assistant', model: 'claude-sonnet-4-6',
      content: blocks.length > 0
        ? blocks.map(block => ({ type: 'tool_use', input: {}, ...block }))
        : [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: outputTokens, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 },
    },
  })
}

function write(name: string, lines: string[]): string {
  const path = join(project, name)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

function setClaudeCodeParserVersion(value: number | undefined): void {
  const watermark = JSON.parse(readFileSync(watermarkPath, 'utf-8'))
  if (value === undefined) delete watermark.claudeCodeParserVersion
  else watermark.claudeCodeParserVersion = value
  writeFileSync(watermarkPath, JSON.stringify(watermark))
}

function giveDevice(): void {
  writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE, lastSyncStatus: 'ok' }))
}

/**
 * As a release before v1.5.23 left a record's calls: inserting the record
 * again deleted them, so only those of the line it was last written from are
 * kept (the ones with its timestamp), under positional ids (issue #89).
 */
function keepCallsAsBeforeV1523(recordIds: string[]): void {
  for (const id of recordIds) {
    const { ts } = db.prepare('SELECT ts FROM records WHERE id = ?').get(id) as { ts: number }
    const calls = db.prepare('SELECT name, ts, call_index FROM tool_calls WHERE record_id = ?').all(id) as Array<{ name: string; ts: number; call_index: number }>
    db.prepare('DELETE FROM tool_calls WHERE record_id = ?').run(id)
    for (const call of calls.filter(c => c.ts === ts)) {
      db.prepare('INSERT OR REPLACE INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, ?, ?)')
        .run(generateToolCallId(id, call.name, call.ts, call.call_index), id, call.name, call.ts, call.call_index)
    }
  }
}

/** v1.5.22/v1.5.23: the logs are read under the device id without finding the originals. */
async function storeAgainAsV1523(reread: () => Promise<unknown>): Promise<void> {
  db.pragma('foreign_keys = OFF')
  db.prepare("UPDATE records SET id = 'hidden:' || id").run()
  db.prepare("UPDATE tool_calls SET record_id = 'hidden:' || record_id WHERE record_id IS NOT NULL").run()
  await reread()
  db.prepare("UPDATE records SET id = substr(id, 8) WHERE id LIKE 'hidden:%'").run()
  db.prepare("UPDATE tool_calls SET record_id = substr(record_id, 8) WHERE record_id LIKE 'hidden:%'").run()
  db.pragma('foreign_keys = ON')
}

const sentinel = (messageId: string) => generateRecordId('unknown', messageId, 0)
const own = (messageId: string) => generateRecordId(DEVICE, messageId, 0)

/**
 * Parses the transcripts as a release before v1.5.22 without sync did, then
 * as v1.5.23 did once it had created the device id: every message is stored
 * twice, the copy with every call of the message under its block.
 */
async function storedTwiceByV1523(): Promise<void> {
  vi.setSystemTime(Date.parse('2026-09-10T00:00:00Z'))
  await runParse(db, 'claude-code')
  keepCallsAsBeforeV1523((db.prepare('SELECT id FROM records').all() as Array<{ id: string }>).map(r => r.id))
  setClaudeCodeParserVersion(undefined)
  giveDevice()
  vi.setSystemTime(Date.parse('2026-10-20T00:00:00Z'))
  await storeAgainAsV1523(() => runParse(db, 'claude-code'))
  setClaudeCodeParserVersion(1)
  vi.setSystemTime(Date.parse('2026-10-28T00:00:00Z'))
}

/** The first run of this release: migrations (v17), then a parse. */
async function upgrade(): Promise<void> {
  rerunV17()
  await runParse(db, 'claude-code')
}

// initializeDatabase ran v17 on the empty database; run it again on the rows.
function rerunV17(): void {
  db.prepare('DELETE FROM schema_version WHERE version >= 17').run()
  migrateV17(db)
}

function ids(): string[] {
  return (db.prepare('SELECT id FROM records ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
}

function callsOf(recordId: string): string[] {
  return (db.prepare('SELECT id FROM tool_calls WHERE record_id = ? ORDER BY id').all(recordId) as Array<{ id: string }>).map(r => r.id)
}

function dump(): Record<string, unknown[]> {
  return {
    records: db.prepare('SELECT * FROM records ORDER BY id').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    syncState: db.prepare('SELECT * FROM sync_record_state ORDER BY record_id, target').all(),
    retired: db.prepare('SELECT * FROM sync_retired_wire_ids ORDER BY target, wire_id').all(),
  }
}

/** A sync to `target` acknowledging every local row as it is now. */
function acknowledge(target: string): void {
  db.prepare(`
    INSERT INTO sync_record_state (record_id, target, synced_at)
    SELECT id, ?, updated_at FROM records WHERE origin = 'local'
    ON CONFLICT(record_id, target) DO UPDATE SET synced_at = excluded.synced_at
  `).run(target)
  db.prepare(`UPDATE records SET synced_at = updated_at WHERE origin = 'local'`).run()
}

/** Two transcripts: one is kept, the other is deleted after v1.5.23 read it. */
function twoTranscripts(): { kept: string; deleted: string } {
  const kept = write('kept.jsonl', [
    line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b1', name: 'Read' }]),
    line('m1', '2026-09-01T00:00:01.000Z', 6, [{ id: 'b2', name: 'Edit' }]),
    line('m2', '2026-09-01T00:01:00.000Z', 7, []),
  ])
  const deleted = write('deleted.jsonl', [
    line('m3', '2026-09-02T00:00:00.000Z', 8, [{ id: 'b3', name: 'Read' }]),
    line('m3', '2026-09-02T00:00:01.000Z', 9, [{ id: 'b4', name: 'Bash' }]),
    line('m4', '2026-09-02T00:02:00.000Z', 10, [{ id: 'b5', name: 'Read' }, { id: 'b6', name: 'Grep' }]),
  ])
  return { kept, deleted }
}

describe('Claude Code copies whose transcript is gone', () => {
  it('folds each copy into its original, which takes the copy\'s calls', async () => {
    const { deleted } = twoTranscripts()
    await storedTwiceByV1523()
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4'].flatMap(m => [sentinel(m), own(m)]).sort())
    unlinkSync(deleted)
    const before = new Map((db.prepare('SELECT * FROM records').all() as Array<{ id: string }>).map(r => [r.id, r]))

    await upgrade()

    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4'].map(sentinel).sort())
    // The originals of the deleted transcript are left exactly as they were:
    // same values, same updated_at, nothing to upload again.
    for (const m of ['m3', 'm4']) {
      expect(db.prepare('SELECT * FROM records WHERE id = ?').get(sentinel(m))).toEqual(before.get(sentinel(m)))
    }
    // One call per tool_use block: the kept transcript's are read again under
    // the original's id; the deleted one's are the copy's, which v1.5.23
    // restored, and replace the one call the original had kept.
    expect(callsOf(sentinel('m1'))).toEqual([generateBlockToolCallId(sentinel('m1'), 'b1'), generateBlockToolCallId(sentinel('m1'), 'b2')].sort())
    expect(callsOf(sentinel('m3'))).toEqual([generateBlockToolCallId(own('m3'), 'b3'), generateBlockToolCallId(own('m3'), 'b4')].sort())
    expect(callsOf(sentinel('m4'))).toEqual([generateBlockToolCallId(own('m4'), 'b5'), generateBlockToolCallId(own('m4'), 'b6')].sort())
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 6 })
    expect(getRetiredWireIds(db, CLOUD)).toEqual([])

    // Done once: a further parse changes nothing.
    const after = dump()
    await runParse(db, 'claude-code')
    expect(dump()).toEqual(after)
  })

  it('ends as the re-read of the transcript would, but for the ids of the calls', async () => {
    const { deleted } = twoTranscripts()
    await storedTwiceByV1523()
    const image = db.serialize()
    const watermark = readFileSync(watermarkPath)
    const comparable = () => ({
      records: db.prepare('SELECT * FROM records ORDER BY id').all(),
      calls: db.prepare('SELECT record_id, name, ts, call_index FROM tool_calls ORDER BY record_id, ts, call_index, name').all(),
      syncState: db.prepare('SELECT * FROM sync_record_state ORDER BY record_id, target').all(),
      retired: db.prepare('SELECT * FROM sync_retired_wire_ids').all(),
    })

    // The transcript is still there: the re-read folds the copies.
    await upgrade()
    const reread = comparable()

    db.close()
    db = new Database(image)
    applyPragmas(db)
    writeFileSync(watermarkPath, watermark)
    unlinkSync(deleted)
    await upgrade()

    expect(comparable()).toEqual(reread)
  })

  it('leaves a copy whose transcript still exists to the re-read, which ends as it always did', async () => {
    twoTranscripts()
    await storedTwiceByV1523()
    const image = db.serialize()
    const watermark = readFileSync(watermarkPath)

    rerunV17()
    expect(ids()).toHaveLength(8)
    await runParse(db, 'claude-code')
    const withMigration = dump()

    // The same database parsed without running the migration again.
    db.close()
    db = new Database(image)
    applyPragmas(db)
    writeFileSync(watermarkPath, watermark)
    await runParse(db, 'claude-code')

    expect(dump()).toEqual(withMigration)
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4'].map(sentinel).sort())
  })

  it('leaves both sync targets with what they have: the copy published the original\'s wire id', async () => {
    const { deleted } = twoTranscripts()
    await storedTwiceByV1523()
    // Sync set up after v1.5.23: both rows of each message were uploaded.
    acknowledge(CLOUD)
    acknowledge(FILE_TARGET)
    expect(buildLocalSnapshot(db, DEVICE).collisions).toHaveLength(4)
    unlinkSync(deleted)

    await upgrade()

    expect(getRetiredWireIds(db, CLOUD)).toEqual([])
    expect(getRetiredWireIds(db, FILE_TARGET)).toEqual([])
    expect(getUnsyncedRecords(db, CLOUD, DEVICE)).toEqual([])
    expect(getUnsyncedRecords(db, FILE_TARGET, DEVICE)).toEqual([])
    const snapshot = buildLocalSnapshot(db, DEVICE)
    expect(snapshot.collisions).toEqual([])
    expect(snapshot.records.size).toBe(4)
  })

  it('keeps one call per block when v1.5.22 stored the copy under positional ids', async () => {
    const { deleted } = twoTranscripts()
    await storedTwiceByV1523()
    // v1.5.22, not v1.5.23, read the log under the device id, and the
    // transcript was deleted before v1.5.23 could read it again.
    keepCallsAsBeforeV1523(['m3', 'm4'].map(own))
    unlinkSync(deleted)

    rerunV17()

    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4'].map(sentinel).concat(['m1', 'm2'].map(own)).sort())
    // Both rows held only the calls of the message's last line.
    const ts = (iso: string) => Date.parse(iso)
    expect(callsOf(sentinel('m3'))).toEqual([generateToolCallId(own('m3'), 'Bash', ts('2026-09-02T00:00:01.000Z'), 0)])
    expect(callsOf(sentinel('m4'))).toEqual([
      generateToolCallId(own('m4'), 'Read', ts('2026-09-02T00:02:00.000Z'), 0),
      generateToolCallId(own('m4'), 'Grep', ts('2026-09-02T00:02:00.000Z'), 1),
    ].sort())
  })

  it('keeps both of two parallel calls that share a name, a timestamp and an index', async () => {
    const path = write('s.jsonl', [
      line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b1', name: 'Read' }]),
      line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b2', name: 'Read' }]),
    ])
    await storedTwiceByV1523()
    // The original's one positional call stood for both blocks.
    expect(callsOf(sentinel('m1'))).toHaveLength(1)
    unlinkSync(path)

    rerunV17()

    expect(ids()).toEqual([sentinel('m1')])
    expect(callsOf(sentinel('m1'))).toEqual([generateBlockToolCallId(own('m1'), 'b1'), generateBlockToolCallId(own('m1'), 'b2')].sort())
  })
})

describe('Claude Code rows that are not provably one message', () => {
  it('leaves two messages that a rewritten transcript put at the same line', async () => {
    const path = write('s.jsonl', [line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b1', name: 'Read' }])])
    vi.setSystemTime(Date.parse('2026-09-10T00:00:00Z'))
    await runParse(db, 'claude-code')
    keepCallsAsBeforeV1523([sentinel('m1')])
    // The file is replaced by another message at the same offset.
    write('s.jsonl', [line('m2', '2026-09-01T00:05:00.000Z', 7, [{ id: 'b2', name: 'Read' }])])
    setClaudeCodeParserVersion(undefined)
    giveDevice()
    vi.setSystemTime(Date.parse('2026-10-20T00:00:00Z'))
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    unlinkSync(path)
    const before = dump()

    rerunV17()

    expect(dump()).toEqual(before)
    expect(ids()).toEqual([sentinel('m1'), own('m2')].sort())
  })

  it('leaves them when the line\'s values agree but its calls do not', async () => {
    const path = write('s.jsonl', [line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b1', name: 'Read' }])])
    vi.setSystemTime(Date.parse('2026-09-10T00:00:00Z'))
    await runParse(db, 'claude-code')
    keepCallsAsBeforeV1523([sentinel('m1')])
    write('s.jsonl', [line('m2', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b2', name: 'Bash' }])])
    setClaudeCodeParserVersion(undefined)
    giveDevice()
    vi.setSystemTime(Date.parse('2026-10-20T00:00:00Z'))
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    unlinkSync(path)
    const before = dump()

    rerunV17()

    expect(dump()).toEqual(before)
  })

  it('leaves a message whose original was stored from an earlier line than its copy', async () => {
    // The message was still being written when it was first parsed.
    const path = write('s.jsonl', [line('m1', '2026-09-01T00:00:00.000Z', 5, [{ id: 'b1', name: 'Read' }])])
    vi.setSystemTime(Date.parse('2026-09-10T00:00:00Z'))
    await runParse(db, 'claude-code')
    keepCallsAsBeforeV1523([sentinel('m1')])
    appendFileSync(path, line('m1', '2026-09-01T00:00:01.000Z', 6, [{ id: 'b2', name: 'Read' }]) + '\n')
    setClaudeCodeParserVersion(undefined)
    giveDevice()
    vi.setSystemTime(Date.parse('2026-10-20T00:00:00Z'))
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    unlinkSync(path)
    const before = dump()

    rerunV17()

    expect(dump()).toEqual(before)
  })

  it('folds nothing without a device id', async () => {
    const { deleted } = twoTranscripts()
    await storedTwiceByV1523()
    unlinkSync(deleted)
    rmSync(join(aiusageDir, 'state.json'))
    const before = dump()

    rerunV17()

    expect(dump()).toEqual(before)
  })

  describe('rows stored at one line of a transcript that is gone', () => {
    const base: StatsRecord = {
      id: '', ts: 1_000, ingestedAt: 1, updatedAt: 1, lineOffset: 40, tool: 'claude-code', model: 'claude-sonnet-4-6',
      provider: 'anthropic', inputTokens: 100, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 10, thinkingTokens: 0,
      cost: 0, costSource: 'pricing', sessionId: 's', sourceFile: '/gone/proj/s.jsonl', device: 'd', deviceInstanceId: DEVICE, origin: 'local',
    }
    const call = (recordId: string, name: string, id = generateToolCallId(recordId, name, 1_000, 0)) =>
      db.prepare('INSERT INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, 1000, 0)').run(id, recordId, name)

    function pair(original: Partial<StatsRecord>, copy: Partial<StatsRecord>): void {
      insertRecord(db, { ...base, id: sentinel('m1'), ...original })
      insertRecord(db, { ...base, id: own('m1'), ingestedAt: 2, updatedAt: 2, ...copy })
    }

    it('folds a pair of this device, matching a Skill call kept under its old name', () => {
      pair({}, {})
      call(sentinel('m1'), 'Skill')
      call(own('m1'), 'skill__commit', generateBlockToolCallId(own('m1'), 'b1'))
      // A record built from the line by a release before ids were built from
      // the message id is a record of its own, and is left alone.
      const lineRecord = generateRecordId('unknown', base.sourceFile, base.lineOffset)
      insertRecord(db, { ...base, id: lineRecord })

      expect(foldClaudeCodeCopiesOfGoneTranscripts(db, DEVICE)).toBe(1)
      expect(ids()).toEqual([sentinel('m1'), lineRecord].sort())
      expect(callsOf(sentinel('m1'))).toEqual([generateBlockToolCallId(own('m1'), 'b1')])
    })

    it('leaves rows of another device and rows pulled from one', () => {
      pair({ deviceInstanceId: 'other-device' }, {})
      insertRecord(db, { ...base, id: sentinel('m2'), lineOffset: 80, origin: 'synced' })
      insertRecord(db, { ...base, id: own('m2'), lineOffset: 80, ingestedAt: 2 })
      insertRecord(db, { ...base, id: sentinel('m3'), lineOffset: 120 })
      insertRecord(db, { ...base, id: own('m3'), lineOffset: 120, ingestedAt: 2, deviceInstanceId: 'other-device' })
      const before = dump()

      expect(foldClaudeCodeCopiesOfGoneTranscripts(db, DEVICE)).toBe(0)
      expect(dump()).toEqual(before)
    })

    it('leaves a pair it cannot order, ids built from the line, and values that differ', () => {
      pair({ ingestedAt: 2 }, {})
      const lineId = (device: string, offset: number) => generateRecordId(device, base.sourceFile, offset)
      insertRecord(db, { ...base, id: lineId('unknown', 80), lineOffset: 80 })
      insertRecord(db, { ...base, id: own('m2'), lineOffset: 80, ingestedAt: 2 })
      insertRecord(db, { ...base, id: sentinel('m3'), lineOffset: 120 })
      insertRecord(db, { ...base, id: own('m3'), lineOffset: 120, ingestedAt: 2, cacheReadTokens: 999 })
      // Only a parse without a device id labels a row 'unknown', and copies
      // were stored with one: a later row labelled so is not a copy.
      insertRecord(db, { ...base, id: sentinel('m4'), lineOffset: 160 })
      insertRecord(db, { ...base, id: own('m4'), lineOffset: 160, ingestedAt: 2, deviceInstanceId: 'unknown' })
      const before = dump()

      expect(foldClaudeCodeCopiesOfGoneTranscripts(db, DEVICE)).toBe(0)
      expect(dump()).toEqual(before)
    })

    it('leaves a pair whose original holds a call the copy does not', () => {
      pair({}, {})
      call(sentinel('m1'), 'Read')
      call(own('m1'), 'Read', generateBlockToolCallId(own('m1'), 'b1'))
      db.prepare('INSERT INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, 1000, 1)')
        .run(generateToolCallId(sentinel('m1'), 'Bash', 1_000, 1), sentinel('m1'), 'Bash')
      const before = dump()

      expect(foldClaudeCodeCopiesOfGoneTranscripts(db, DEVICE)).toBe(0)
      expect(dump()).toEqual(before)
    })
  })
})
