import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { generateBlockToolCallId, generateRecordId, generateSyncRecordId, generateToolCallId } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { getRetiredWireIds } from '../../src/db/sync-claims.js'
import { runParse } from '../../src/commands/parse.js'

vi.mock('../../src/sync/cloud.js', () => ({
  CloudSyncError: class CloudSyncError extends Error {},
  cloudPull: vi.fn(async () => ({ records: [], tombstones: [], hasMore: false, syncGeneration: 1 })),
  cloudPush: vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, syncGeneration: 1 })),
}))

// A Claude Code message can sit in several transcripts (a resumed session),
// each holding it at a different stage, and a transcript can be deleted. The
// original row (stored under the 'unknown' device id) and the copy v1.5.23
// stored (under the device's own id) can each hold something the other does
// not. Folding the copy into the original keeps the later state, every call,
// and does not retract a wire id the original is published under.
// tests/setup-home.ts gives this file its own home directory.

const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const DEVICE = '11111111-2222-3333-4444-555555555555'

let db: Database.Database
let src: string
let project: string

beforeEach(() => {
  rmSync(aiusageDir, { recursive: true, force: true })
  mkdirSync(aiusageDir, { recursive: true })
  src = mkdtempSync(join(tmpdir(), 'aiu-fold-'))
  project = join(src, 'proj')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'claude-code': src } }))
  db = new Database(':memory:')
  initializeDatabase(db)
  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
  rmSync(src, { recursive: true, force: true })
})

function line(ts: string, outputTokens: number, blockId: string): string {
  return JSON.stringify({
    type: 'assistant', cwd: '/work', timestamp: ts,
    message: {
      id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: blockId, name: 'Read', input: {} }],
      usage: { input_tokens: 100, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

/** v1.5.22/v1.5.23: the source is read under the device id without finding the original. */
async function storeAgainAsV1523(reread: () => Promise<unknown>): Promise<void> {
  db.pragma('foreign_keys = OFF')
  db.prepare("UPDATE records SET id = 'hidden:' || id").run()
  db.prepare("UPDATE tool_calls SET record_id = 'hidden:' || record_id WHERE record_id IS NOT NULL").run()
  await reread()
  db.prepare("UPDATE records SET id = substr(id, 8) WHERE id LIKE 'hidden:%'").run()
  db.prepare("UPDATE tool_calls SET record_id = substr(record_id, 8) WHERE record_id LIKE 'hidden:%'").run()
  db.pragma('foreign_keys = ON')
}

const ORIGINAL = generateRecordId('unknown', 'm1', 0)
const COPY = generateRecordId(DEVICE, 'm1', 0)

function stored(): { id: string; ts: number; output_tokens: number; source_file: string; line_offset: number } {
  const rows = db.prepare('SELECT id, ts, output_tokens, source_file, line_offset FROM records').all() as Array<{ id: string; ts: number; output_tokens: number; source_file: string; line_offset: number }>
  expect(rows).toHaveLength(1)
  return rows[0]
}

function calls(): string[] {
  return (db.prepare('SELECT id FROM tool_calls ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
}

describe('folding a Claude Code copy into its original', () => {
  it('keeps the original\'s later state when the copy came from an older transcript', async () => {
    // Before v1.5.22: the message's final state, from a transcript since deleted.
    const finished = write('a.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1'), line('2026-09-01T00:00:01Z', 10, 'b2')])
    await runParse(db, 'claude-code')
    unlinkSync(finished)
    // v1.5.23 read a resumed transcript that holds only the message's start.
    write('b.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1')])
    setClaudeCodeParserVersion(undefined)
    giveDevice()
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    setClaudeCodeParserVersion(1)

    await runParse(db, 'claude-code')

    expect(stored()).toMatchObject({ id: ORIGINAL, ts: Date.parse('2026-09-01T00:00:01Z'), output_tokens: 10 })
    expect(calls()).toEqual([generateBlockToolCallId(ORIGINAL, 'b1'), generateBlockToolCallId(ORIGINAL, 'b2')].sort())
  })

  it('keeps the calls the copy took from a transcript that is gone', async () => {
    write('a.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1')])
    await runParse(db, 'claude-code')
    // v1.5.23 also read a resumed transcript with a later block, since deleted.
    const resumed = write('b.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1'), line('2026-09-01T00:00:01Z', 10, 'b2')])
    setClaudeCodeParserVersion(undefined)
    giveDevice()
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    setClaudeCodeParserVersion(1)
    unlinkSync(resumed)

    await runParse(db, 'claude-code')

    expect(stored()).toMatchObject({ id: ORIGINAL, output_tokens: 10 })
    // b1 is read again and written under the original's id; b2 can no
    // longer be read and stays under the id the copy gave it.
    expect(calls()).toEqual([generateBlockToolCallId(ORIGINAL, 'b1'), generateBlockToolCallId(COPY, 'b2')].sort())
    expect(db.prepare('SELECT DISTINCT record_id FROM tool_calls').all()).toEqual([{ record_id: ORIGINAL }])

    // Done once: a further full read changes nothing.
    const before = { record: stored(), calls: calls() }
    setClaudeCodeParserVersion(1)
    await runParse(db, 'claude-code')
    expect({ record: stored(), calls: calls() }).toEqual(before)
  })

  it('replaces the positional calls of a copy that v1.5.22 wrote', async () => {
    const file = write('a.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1')])
    await runParse(db, 'claude-code')
    // v1.5.22 read the message again (a lost watermark) and, before #137,
    // stored its call under a positional id.
    giveDevice()
    await storeAgainAsV1523(async () => {
      unlinkSync(watermarkPath)
      await runParse(db, 'claude-code')
    })
    const ts = Date.parse('2026-09-01T00:00:00Z')
    db.prepare('UPDATE tool_calls SET id = ? WHERE record_id = ?').run(generateToolCallId(COPY, 'Read', ts, 0), COPY)
    setClaudeCodeParserVersion(undefined)

    await runParse(db, 'claude-code')

    expect(stored()).toMatchObject({ id: ORIGINAL, source_file: file })
    expect(calls()).toEqual([generateBlockToolCallId(ORIGINAL, 'b1')])
  })

  it('keeps a positional call of a v1.5.22 copy that another block only resembles', async () => {
    // Two parallel calls of one message: same name, timestamp and index.
    const ts = '2026-09-01T00:00:00Z'
    const first = write('a.jsonl', [line(ts, 5, 'b1')])
    await runParse(db, 'claude-code')
    // v1.5.22 read a resumed transcript holding the message with both calls
    // and kept the call of its last line, b2, under a positional id. That
    // transcript is gone since.
    rmSync(first)
    const resumed = write('b.jsonl', [line(ts, 5, 'b1'), line(ts, 6, 'b2')])
    giveDevice()
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    db.prepare('DELETE FROM tool_calls WHERE record_id = ?').run(COPY)
    db.prepare('INSERT INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, ?, 0)')
      .run(generateToolCallId(COPY, 'Read', Date.parse(ts), 0), COPY, 'Read', Date.parse(ts))
    unlinkSync(resumed)
    write('a.jsonl', [line(ts, 5, 'b1')])
    setClaudeCodeParserVersion(undefined)

    await runParse(db, 'claude-code')

    // b1 is read again; b2's call came from another line and stays.
    expect(stored()).toMatchObject({ id: ORIGINAL, output_tokens: 6 })
    expect(calls()).toEqual([generateBlockToolCallId(ORIGINAL, 'b1'), generateToolCallId(COPY, 'Read', Date.parse(ts), 0)].sort())
  })

  it('keeps a positional call of a copy that a later release wrote from its line again', async () => {
    // Two parallel calls of one message: same name, timestamp and index.
    const ts = '2026-09-01T00:00:00Z'
    write('a.jsonl', [line(ts, 6, 'b2')])
    await runParse(db, 'claude-code')
    // The copy: v1.5.22 kept b1's call under a positional id (its transcript
    // is gone since), then v1.5.23 read b2 into it from this line, under its
    // block-keyed id, and left that positional row alone.
    giveDevice()
    await storeAgainAsV1523(async () => {
      unlinkSync(watermarkPath)
      await runParse(db, 'claude-code')
    })
    db.prepare('INSERT INTO tool_calls (id, record_id, name, ts, call_index) VALUES (?, ?, ?, ?, 0)')
      .run(generateToolCallId(COPY, 'Read', Date.parse(ts), 0), COPY, 'Read', Date.parse(ts))
    expect(calls()).toContain(generateBlockToolCallId(COPY, 'b2'))
    setClaudeCodeParserVersion(1)

    await runParse(db, 'claude-code')

    expect(stored()).toMatchObject({ id: ORIGINAL })
    expect(calls()).toEqual([generateBlockToolCallId(ORIGINAL, 'b2'), generateToolCallId(COPY, 'Read', Date.parse(ts), 0)].sort())
  })

  it('does not retract the wire id the original moves onto', async () => {
    // The message's first block was read before v1.5.22...
    const file = write('a.jsonl', [line('2026-09-01T00:00:00Z', 5, 'b1')])
    await runParse(db, 'claude-code')
    // ...and its second block by v1.5.22, under the device id, then uploaded.
    giveDevice()
    appendFileSync(file, line('2026-09-01T00:00:01Z', 10, 'b2') + '\n')
    await storeAgainAsV1523(() => runParse(db, 'claude-code'))
    setClaudeCodeParserVersion(1)
    const copy = db.prepare('SELECT line_offset FROM records WHERE id = ?').get(COPY) as { line_offset: number }
    db.prepare("INSERT INTO sync_record_state (record_id, target, synced_at) SELECT id, 'cloud', updated_at FROM records WHERE id = ?").run(COPY)
    const copyWireId = generateSyncRecordId(DEVICE, file, copy.line_offset)

    await runParse(db, 'claude-code')

    // The original now ends at the copy's line, so it is published under the
    // copy's wire id.
    expect(stored()).toMatchObject({ id: ORIGINAL, line_offset: copy.line_offset, output_tokens: 10 })

    const { CloudSyncOrchestrator } = await import('../../src/sync/cloud-orchestrator.js')
    const { cloudPush } = await import('../../src/sync/cloud.js')
    const result = await new CloudSyncOrchestrator(db, { deviceInstanceId: DEVICE }).sync()

    expect(result.status).toBe('ok')
    const pushes = vi.mocked(cloudPush).mock.calls
    expect(pushes.flatMap(c => c[0].map(r => r.id))).toEqual([copyWireId])
    expect(pushes.flatMap(c => c[1].map(t => t.record_id))).not.toContain(copyWireId)
    expect(getRetiredWireIds(db, 'cloud')).toEqual([])
  })
})
