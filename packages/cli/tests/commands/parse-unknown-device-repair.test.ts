import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { generateBlockToolCallId, generateRecordId, generateSyncRecordId, generateToolCallId } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, insertRecord, recordIdForReread } from '../../src/db/records.js'
import { getRetiredWireIds } from '../../src/db/sync-claims.js'
import { migrateV17 } from '../../src/db/migrations/v17.js'
import { runParse } from '../../src/commands/parse.js'
import { buildLocalSnapshot } from '../../src/sync/index.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'

// Databases that v1.5.22 and v1.5.23 left with records stored twice: once
// under the id built from the 'unknown' device id (parsed before the
// installation had a device id) and once under the device's own id (the same
// source read again afterwards). tests/setup-home.ts gives this file its own
// home directory.

const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const DEVICE = '11111111-2222-3333-4444-555555555555'
const CLOUD = 'cloud:https://sync.example.test'
const FILE_TARGET = 'github:someone/usage-data'

let db: Database.Database
let src: string

beforeEach(() => {
  rmSync(aiusageDir, { recursive: true, force: true })
  mkdirSync(aiusageDir, { recursive: true })
  src = mkdtempSync(join(tmpdir(), 'aiu-repair-'))
  db = new Database(':memory:')
  initializeDatabase(db)
})

afterEach(() => {
  db.close()
  rmSync(src, { recursive: true, force: true })
})

function configure(sources: Record<string, string>): void {
  writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources }))
}

function giveDevice(): void {
  writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE, lastSyncStatus: 'ok' }))
}

function setWatermarkField(field: string, value: number | undefined): void {
  const watermark = JSON.parse(readFileSync(watermarkPath, 'utf-8'))
  if (value === undefined) delete watermark[field]
  else watermark[field] = value
  writeFileSync(watermarkPath, JSON.stringify(watermark))
}

function jsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

function ids(tool: string): string[] {
  return (db.prepare('SELECT id FROM records WHERE tool = ? ORDER BY id').all(tool) as Array<{ id: string }>).map(r => r.id)
}

function rowsOf(tool: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM records WHERE tool = ? ORDER BY id').all(tool) as Array<Record<string, unknown>>
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

/**
 * Reads a source again the way v1.5.22 and v1.5.23 did on an installation
 * that parsed it before it had a device id: without finding the rows stored
 * under the 'unknown' ids, so every record it reads is stored again under the
 * device's own id. The earlier rows are hidden while `reread` runs.
 */
async function storeAgainAsV1523(reread: () => Promise<unknown>): Promise<void> {
  db.pragma('foreign_keys = OFF')
  db.prepare("UPDATE records SET id = 'hidden:' || id").run()
  db.prepare("UPDATE tool_calls SET record_id = 'hidden:' || record_id WHERE record_id IS NOT NULL").run()
  await reread()
  db.prepare("UPDATE records SET id = substr(id, 8) WHERE id LIKE 'hidden:%'").run()
  db.prepare("UPDATE tool_calls SET record_id = substr(record_id, 8) WHERE record_id LIKE 'hidden:%'").run()
  db.pragma('foreign_keys = ON')
}

function claudeLine(messageId: string, ts: string, outputTokens: number, blockId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    cwd: '/work',
    timestamp: ts,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: blockId, name: 'Read', input: {} }],
      usage: { input_tokens: 100, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }
}

const sentinel = (seed: string, offset: number) => generateRecordId('unknown', seed, offset)
const own = (seed: string, offset: number) => generateRecordId(DEVICE, seed, offset)

describe('Claude Code records v1.5.23 stored twice', () => {
  async function duplicatedHistory(): Promise<void> {
    configure({ 'claude-code': src })
    jsonl(join(src, 'proj', 's.jsonl'), [
      claudeLine('m1', '2026-09-01T00:00:00Z', 5, 'b1'),
      claudeLine('m1', '2026-09-01T00:00:01Z', 6, 'b2'),
      claudeLine('m2', '2026-09-01T00:01:00Z', 7, 'b3'),
    ])
    // A release before v1.5.22 without sync: no device id.
    await runParse(db, 'claude-code')
    // Releases before v1.5.23 kept about one call per message, under a
    // positional id (issue #89).
    db.prepare('DELETE FROM tool_calls').run()
    for (const r of db.prepare('SELECT id, ts FROM records').all() as Array<{ id: string; ts: number }>) {
      db.prepare('INSERT INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, ?, 0)')
        .run(generateToolCallId(r.id, 'Read', r.ts, 0), r.id, 'Read', r.ts)
    }
    setWatermarkField('claudeCodeParserVersion', undefined)
    // v1.5.22 created the device id; v1.5.23's one-time re-import stored every
    // message again and recorded Claude Code parser version 1.
    giveDevice()
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    setWatermarkField('claudeCodeParserVersion', 1)
    expect(ids('claude-code').sort()).toEqual([sentinel('m1', 0), sentinel('m2', 0), own('m1', 0), own('m2', 0)].sort())
  }

  it('keeps the original of each message, with the calls the re-import restored', async () => {
    await duplicatedHistory()

    await runParse(db, 'claude-code')

    expect(ids('claude-code')).toEqual([sentinel('m1', 0), sentinel('m2', 0)].sort())
    const calls = db.prepare('SELECT id, record_id FROM tool_calls ORDER BY id').all()
    expect(calls).toEqual([
      { id: generateBlockToolCallId(sentinel('m1', 0), 'b1'), record_id: sentinel('m1', 0) },
      { id: generateBlockToolCallId(sentinel('m1', 0), 'b2'), record_id: sentinel('m1', 0) },
      { id: generateBlockToolCallId(sentinel('m2', 0), 'b3'), record_id: sentinel('m2', 0) },
    ].sort((a, b) => a.id.localeCompare(b.id)))
    expect(db.prepare('SELECT output_tokens FROM records ORDER BY ts').all()).toEqual([{ output_tokens: 6 }, { output_tokens: 7 }])

    // Done once: a further parse changes nothing.
    const after = rowsOf('claude-code')
    await runParse(db, 'claude-code')
    expect(rowsOf('claude-code')).toEqual(after)
  })

  it('leaves both sync targets with what they have: the copy shared the original\'s wire id', async () => {
    await duplicatedHistory()
    // Sync set up after v1.5.23: both rows of each message were uploaded.
    acknowledge(CLOUD)
    acknowledge(FILE_TARGET)
    expect(buildLocalSnapshot(db, DEVICE).collisions).toHaveLength(2)

    await runParse(db, 'claude-code')

    expect(getRetiredWireIds(db, CLOUD)).toEqual([])
    expect(getUnsyncedRecords(db, CLOUD, DEVICE)).toEqual([])
    expect(getUnsyncedRecords(db, FILE_TARGET, DEVICE)).toEqual([])
    const snapshot = buildLocalSnapshot(db, DEVICE)
    expect(snapshot.collisions).toEqual([])
    expect(snapshot.records.size).toBe(2)
  })

  it('retracts a copy that was uploaded under another transcript\'s wire id', async () => {
    configure({ 'claude-code': src })
    const first = join(src, 'proj', 'a.jsonl')
    const second = join(src, 'proj', 'b.jsonl')
    const line = claudeLine('m1', '2026-09-01T00:00:00Z', 5, 'b1')
    jsonl(first, [line])
    jsonl(second, [line])
    await runParse(db, 'claude-code')
    // Releases before v1.5.23 left a message copied into two transcripts with
    // the one read last.
    db.prepare('UPDATE records SET source_file = ?').run(second)
    setWatermarkField('claudeCodeParserVersion', undefined)
    giveDevice()
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    setWatermarkField('claudeCodeParserVersion', 1)
    const copy = db.prepare('SELECT * FROM records WHERE id = ?').get(own('m1', 0)) as { source_file: string; line_offset: number }
    expect(copy.source_file).toBe(first)
    acknowledge(CLOUD)

    await runParse(db, 'claude-code')

    expect(ids('claude-code')).toEqual([sentinel('m1', 0)])
    expect((db.prepare('SELECT source_file FROM records').get() as { source_file: string }).source_file).toBe(second)
    expect(getRetiredWireIds(db, CLOUD)).toEqual([generateSyncRecordId(DEVICE, first, copy.line_offset)])
  })
})

describe('Kelivo records stored twice', () => {
  const message = (id: string, minute: number) => ({
    id, role: 'assistant', timestamp: `2026-06-05T10:0${minute}:00.000Z`, modelId: 'gpt-4o', providerId: 'openai',
    promptTokens: 100, completionTokens: 20, conversationId: 'c1',
  })
  const seed = (id: string) => `kelivo:c1:${id}`
  const ts = (minute: number) => Date.parse(`2026-06-05T10:0${minute}:00.000Z`)

  it('folds the copy into the original and retracts it from every target that received it', async () => {
    configure({ kelivo: src })
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [message('a1', 1)] }))
    await runParse(db, 'kelivo')
    giveDevice()
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [message('a1', 1), message('a2', 2)] }))
    await storeAgainAsV1523(() => runParse(db, 'kelivo'))
    expect(ids('kelivo').sort()).toEqual([sentinel(seed('a1'), ts(1)), own(seed('a1'), ts(1)), own(seed('a2'), ts(2))].sort())
    acknowledge(CLOUD)
    acknowledge(FILE_TARGET)

    // The next backup.
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [message('a1', 1), message('a2', 2), message('a3', 3)] }))
    await runParse(db, 'kelivo')

    const copy = own(seed('a1'), ts(1))
    expect(ids('kelivo').sort()).toEqual([sentinel(seed('a1'), ts(1)), own(seed('a2'), ts(2)), own(seed('a3'), ts(3))].sort())
    // Kelivo travels under its record id, so the copy is a record of its own
    // on every target: the cloud gets a tombstone, a file target leaves it out.
    expect(getRetiredWireIds(db, CLOUD)).toEqual([copy])
    expect(getRetiredWireIds(db, FILE_TARGET)).toEqual([copy])
    expect([...buildLocalSnapshot(db, DEVICE).records.keys()].sort()).toEqual(ids('kelivo'))
  })
})

describe('migration v17: copies proven from the stored row', () => {
  // initializeDatabase ran v17 on the empty database; run it again on the rows.
  function rerunV17(): void {
    db.prepare('DELETE FROM schema_version WHERE version >= 17').run()
    migrateV17(db)
  }

  const tokenCount = (outputTokens: number) => ({
    type: 'event_msg', timestamp: '2026-07-06T09:00:00.000Z',
    payload: { type: 'token_count', model: 'gpt-5', info: { last_token_usage: { input_tokens: 100, output_tokens: outputTokens } } },
  })

  async function duplicated(tool: 'codex' | 'codefuse', file: string): Promise<{ original: string; copy: string }> {
    jsonl(file, [tokenCount(20)])
    await runParse(db, tool)
    giveDevice()
    await storeAgainAsV1523(async () => {
      unlinkSync(watermarkPath)
      await runParse(db, tool)
    })
    const row = db.prepare('SELECT source_file, line_offset FROM records LIMIT 1').get() as { source_file: string; line_offset: number }
    return {
      original: generateRecordId('unknown', row.source_file, row.line_offset),
      copy: generateRecordId(DEVICE, row.source_file, row.line_offset),
    }
  }

  it('folds a Codex copy whose log is gone, keeping the newer reading on the original', async () => {
    configure({ codex: src })
    const file = join(src, 'rollout-a.jsonl')
    const { original, copy } = await duplicated('codex', file)
    expect(ids('codex').sort()).toEqual([original, copy].sort())
    db.prepare('UPDATE records SET output_tokens = 25 WHERE id = ?').run(copy)
    acknowledge(CLOUD)
    unlinkSync(file)

    rerunV17()

    expect(ids('codex')).toEqual([original])
    expect(db.prepare('SELECT output_tokens FROM records').get()).toEqual({ output_tokens: 25 })
    // Changed, so published again; under the same wire id, so nothing to retract.
    expect(getUnsyncedRecords(db, CLOUD, DEVICE).map(r => r.id)).toEqual([original])
    expect(getRetiredWireIds(db, CLOUD)).toEqual([])
  })

  it('retracts a CodeFuse copy, which travels under its own id', async () => {
    configure({ codefuse: src })
    const { original, copy } = await duplicated('codefuse', join(src, 'engine', 'codex', 'sessions', 'rollout-e.jsonl'))
    acknowledge(CLOUD)

    rerunV17()

    expect(ids('codefuse')).toEqual([original])
    expect(getRetiredWireIds(db, CLOUD)).toEqual([copy])
  })

  it('leaves rows alone without both a local original and a local copy', () => {
    const record = (id: string, origin: 'local' | 'synced', deviceInstanceId: string) => ({
      id, ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 7, tool: 'codex' as const, model: 'gpt-5', provider: 'openai',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'pricing' as const,
      sessionId: 's', sourceFile: '/logs/rollout.jsonl', device: 'd', deviceInstanceId, origin,
    })
    // A row of this device with no original, and a pulled row under the
    // id another device's 'unknown' parse gave the same line.
    insertRecord(db, record(generateRecordId(DEVICE, '/logs/rollout.jsonl', 7), 'local', DEVICE))
    insertRecord(db, record(generateRecordId('unknown', '/logs/rollout.jsonl', 7), 'synced', 'other-device'))
    const before = db.prepare('SELECT * FROM records ORDER BY id').all()

    rerunV17()

    expect(db.prepare('SELECT * FROM records ORDER BY id').all()).toEqual(before)
  })
})

describe('an installation that always had its device id', () => {
  it('is left exactly as it was by the repeated Claude Code re-import', async () => {
    configure({ 'claude-code': src })
    giveDevice()
    jsonl(join(src, 'proj', 's.jsonl'), [
      claudeLine('m1', '2026-09-01T00:00:00Z', 5, 'b1'),
      claudeLine('m2', '2026-09-01T00:01:00Z', 7, 'b2'),
    ])
    await runParse(db, 'claude-code')
    acknowledge(CLOUD)
    // As v1.5.23 left it.
    setWatermarkField('claudeCodeParserVersion', 1)
    const records = rowsOf('claude-code')
    const calls = db.prepare('SELECT * FROM tool_calls ORDER BY id').all()
    const state = db.prepare('SELECT * FROM sync_record_state ORDER BY record_id').all()

    await runParse(db, 'claude-code')

    expect(rowsOf('claude-code')).toEqual(records)
    expect(db.prepare('SELECT * FROM tool_calls ORDER BY id').all()).toEqual(calls)
    expect(db.prepare('SELECT * FROM sync_record_state ORDER BY record_id').all()).toEqual(state)
    expect(getRetiredWireIds(db, CLOUD)).toEqual([])
    expect(JSON.parse(readFileSync(watermarkPath, 'utf-8')).claudeCodeParserVersion).toBe(2)
  })
})

describe('recordIdForReread', () => {
  it('returns the device\'s own id unless a local row of this device is stored under the sentinel\'s', () => {
    const base = {
      ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0, tool: 'kelivo' as const, model: 'gpt-4o', provider: 'openai',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'pricing' as const,
      sessionId: 'c1', sourceFile: '/backup/chats.json', device: 'd',
    }
    insertRecord(db, { ...base, id: sentinel('pulled', 5), deviceInstanceId: 'other-device', origin: 'synced' })
    insertRecord(db, { ...base, id: sentinel('relabelled', 5), deviceInstanceId: DEVICE, origin: 'local' })
    insertRecord(db, { ...base, id: sentinel('not-yet-relabelled', 5), deviceInstanceId: 'unknown', origin: 'local' })
    const recordId = recordIdForReread(db, DEVICE)

    expect(recordId('new', 5)).toBe(own('new', 5))
    expect(recordId('pulled', 5)).toBe(own('pulled', 5))
    expect(recordId('relabelled', 5)).toBe(sentinel('relabelled', 5))
    expect(recordId('not-yet-relabelled', 5)).toBe(sentinel('not-yet-relabelled', 5))
    // Without a device id there is nothing to look up.
    expect(recordIdForReread(db, 'unknown')('relabelled', 5)).toBe(sentinel('relabelled', 5))
  })

  it('folds a copy only into a local original, and maps the original\'s wire id as relabelled', () => {
    const base = {
      ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 3, tool: 'claude-code' as const, model: 'claude-sonnet-4-6', provider: 'anthropic',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'pricing' as const,
      sessionId: 's', sourceFile: '/p/s.jsonl', device: 'd', origin: 'local' as const,
    }
    // The original is not relabelled yet; once it is, it publishes the copy's wire id.
    insertRecord(db, { ...base, id: sentinel('m', 0), deviceInstanceId: 'unknown' })
    insertRecord(db, { ...base, id: own('m', 0), deviceInstanceId: DEVICE })
    db.prepare('INSERT INTO sync_record_state (record_id, target, synced_at) VALUES (?, ?, 1)').run(own('m', 0), CLOUD)
    const wire = mapStatsRecordToSyncRecord({ ...base, id: own('m', 0), deviceInstanceId: DEVICE }).id

    expect(recordIdForReread(db, DEVICE)('m', 0)).toBe(sentinel('m', 0))

    expect(ids('claude-code')).toEqual([sentinel('m', 0)])
    expect(wire).toBe(generateSyncRecordId(DEVICE, '/p/s.jsonl', 3))
    expect(getRetiredWireIds(db, CLOUD)).toEqual([])
  })
})
