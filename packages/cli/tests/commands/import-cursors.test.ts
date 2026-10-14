import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, markRecordVersionsSynced } from '../../src/db/records.js'
import { runParse } from '../../src/commands/parse.js'
import { runParseOpenCode, MAX_PENDING_MESSAGES } from '../../src/commands/parse-opencode.js'
import { runParseKilo } from '../../src/commands/parse-kilo.js'
import { runParseGoose } from '../../src/commands/parse-goose.js'
import { runParseHermes } from '../../src/commands/parse-hermes.js'
import { runParseCursor } from '../../src/commands/parse-cursor.js'
import { runParseTrae } from '../../src/commands/parse-trae.js'

// runParse looks for every tool's data through discovery, which reads the
// home directory, APPDATA, LOCALAPPDATA, the XDG directories and per-tool
// overrides such as AIUSAGE_KILOCODE_DB_PATH. Here it finds no log files and
// only the databases a test names, whatever is installed on the machine and
// whatever the environment says.
const discovery = vi.hoisted(() => ({ dbPaths: {} as Record<string, string> }))
vi.mock('../../src/discovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/discovery.js')>(),
  discoverLogFiles: () => [],
  getDbPath: (sourceKey: string) => discovery.dbPaths[sourceKey] ?? null,
}))

// tests/setup-home.ts points the home directory at a temporary directory of
// this test file, so ~/.aiusage below is never the real one.
const aiusageDir = join(homedir(), '.aiusage')
const DEVICE = 'device-cursor-test'
const NOW = 1_779_500_000_000
const BASE = { device: 'laptop', deviceInstanceId: DEVICE, now: NOW }

let dir: string
const open: Database.Database[] = []

function sourceDb(name: string, schema: string): Database.Database {
  const db = new Database(join(dir, name))
  db.exec(schema)
  open.push(db)
  return db
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiusage-cursors-'))
})

afterEach(() => {
  for (const db of open.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
  discovery.dbPaths = {}
  vi.unstubAllEnvs()
})

const MESSAGE_SCHEMA = `
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
`

function assistant(input: number, output: number, completed: number | null = 1, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role: 'assistant',
    modelID: 'gpt-4o',
    providerID: 'openai',
    cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    time: completed === null ? { created: 1 } : { created: 1, completed },
    ...extra,
  })
}

function putMessage(db: Database.Database, id: string, timeCreated: number, data: string): void {
  db.prepare('INSERT OR REPLACE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(id, 'sess', timeCreated, data)
}

describe.each([
  ['OpenCode', (db: Database.Database, cursor: any, now = NOW) => runParseOpenCode(db, { ...BASE, now, dbPath: '/data/opencode.db', cursor })],
  ['Kilo', (db: Database.Database, cursor: any, now = NOW) => runParseKilo(db, { ...BASE, now, dbPath: '/data/kilo.db', cursor })],
])('%s import and a message that is still being written (#83)', (_name, run) => {
  it('imports the tokens a message gets after it was first seen', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(1000, 100))
    // The response is still streaming: the row exists, its tokens do not.
    putMessage(db, 'msg_2', NOW - 30_000, assistant(0, 0, null))

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([1000])
    // The cursor moves on; the unfinished message is kept by id.
    expect(first.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 30_000, lastMessageId: 'msg_2', pendingMessageIds: ['msg_2'] })

    putMessage(db, 'msg_2', NOW - 30_000, assistant(2000, 200))
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.inputTokens, r.outputTokens])).toEqual([[2000, 200]])
    expect(second.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 30_000, lastMessageId: 'msg_2' })
    const third = run(db, second.nextCursor)
    expect(third.records).toEqual([])
    expect(third.nextCursor).toBeNull()
  })

  it('reads a completed message without tokens and one without a completion time again, and nothing else', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(0, 0))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([500])
    expect(first.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2', pendingMessageIds: ['msg_1'] })

    putMessage(db, 'msg_1', NOW - 60_000, assistant(700, 70, null))
    const second = run(db, first.nextCursor)
    // Tokens but no completion time: imported with what it has, still not
    // final. The finished message behind the cursor is not read again.
    expect(second.records.map(r => r.inputTokens)).toEqual([700])
    expect(second.nextCursor).toEqual(first.nextCursor)

    putMessage(db, 'msg_1', NOW - 60_000, assistant(900, 90))
    const third = run(db, second.nextCursor)
    expect(third.records.map(r => [r.id, r.inputTokens])).toEqual([[second.records[0].id, 900]])
    expect(third.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2' })
  })

  it('imports a message that completes long after it was created, whatever the clock says', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    const day = 24 * 60 * 60 * 1000
    // Already days old when it is first seen, and still unfinished.
    putMessage(db, 'msg_1', NOW - 3 * day, assistant(0, 0, null))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([500])

    // Later runs, with the clock far ahead; the response has not resumed.
    const second = run(db, first.nextCursor, NOW + 30 * day)
    expect(second.records).toEqual([])

    putMessage(db, 'msg_1', NOW - 3 * day, assistant(4000, 400))
    const third = run(db, second.nextCursor, NOW + 60 * day)

    expect(third.records.map(r => [r.inputTokens, r.outputTokens])).toEqual([[4000, 400]])
    expect(third.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2' })
  })

  it('does not come back for a message with a recorded outcome, or for a user message', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(0, 0, 1, { error: { name: 'MessageAbortedError' } }))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(0, 0, 1, { finish: 'stop' }))
    putMessage(db, 'msg_3', NOW - 40_000, JSON.stringify({ role: 'user' }))

    const result = run(db, null)

    expect(result.records).toEqual([])
    expect(result.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 40_000, lastMessageId: 'msg_3' })
  })

  it('reads an unreadable row again until it can be read', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, '{not json')

    const first = run(db, null)
    expect(first.records).toEqual([])
    expect(first.errors).toHaveLength(1)
    expect(first.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 60_000, lastMessageId: 'msg_1', pendingMessageIds: ['msg_1'] })

    // Unreadable in another way, and a newer message arrives: the row is
    // not lost and does not stop the import.
    putMessage(db, 'msg_1', NOW - 60_000, 'null')
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))
    const second = run(db, first.nextCursor)
    expect(second.records.map(r => r.inputTokens)).toEqual([500])
    expect(second.errors).toHaveLength(1)
    expect(second.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2', pendingMessageIds: ['msg_1'] })

    // And in a third: valid JSON that is not a message.
    putMessage(db, 'msg_1', NOW - 60_000, '[]')
    const again = run(db, second.nextCursor)
    expect(again.records).toEqual([])
    expect(again.errors).toHaveLength(1)
    expect(again.nextCursor).toEqual(second.nextCursor)

    putMessage(db, 'msg_1', NOW - 60_000, assistant(300, 30))
    const third = run(db, again.nextCursor)
    expect(third.records.map(r => r.inputTokens)).toEqual([300])
    expect(third.errors).toEqual([])
    expect(third.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2' })
  })

  it('forgets a pending message that is gone, on a run that reads nothing', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(1000, 100))
    putMessage(db, 'msg_2', NOW - 30_000, assistant(0, 0, null))
    const first = run(db, null)

    db.prepare('DELETE FROM message WHERE id = ?').run('msg_2')
    const second = run(db, first.nextCursor)

    expect(second.records).toEqual([])
    expect(second.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 30_000, lastMessageId: 'msg_2' })
  })

  it('keeps the newest pending messages when there are more than the limit', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    const ids = Array.from({ length: MAX_PENDING_MESSAGES + 2 }, (_, i) => `msg_${String(i).padStart(4, '0')}`)
    db.transaction(() => ids.forEach((id, i) => putMessage(db, id, NOW - 1_000_000 + i, assistant(0, 0, null))))()

    const result = run(db, null)

    expect(result.nextCursor!.pendingMessageIds).toEqual(ids.slice(2))
    expect(result.nextCursor!.lastMessageId).toBe(ids[ids.length - 1])
  })

  it('reads messages created at the same time once each', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_b', NOW - 60_000, assistant(200, 20))
    const first = run(db, null)

    // Same creation time as the message the cursor stands on.
    putMessage(db, 'msg_c', NOW - 60_000, assistant(300, 30))
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => r.inputTokens)).toEqual([300])
    expect(second.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 60_000, lastMessageId: 'msg_c' })
  })
})

describe('runParse with both opencode.db and kilo.db (#82)', () => {
  let cache: Database.Database

  beforeEach(() => {
    rmSync(aiusageDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
    cache = new Database(':memory:')
    initializeDatabase(cache)
    open.push(cache)
  })

  function count(tool: string): number {
    return (cache.prepare('SELECT COUNT(*) AS n FROM records WHERE tool = ?').get(tool) as { n: number }).n
  }

  it('gives each database its own cursor', async () => {
    const opencode = sourceDb('opencode.db', MESSAGE_SCHEMA)
    const kilo = sourceDb('kilo.db', MESSAGE_SCHEMA)
    putMessage(opencode, 'oc_1', 1000, assistant(100, 10))
    putMessage(opencode, 'oc_2', 3000, assistant(300, 30))
    putMessage(kilo, 'kilo_1', 2000, assistant(200, 20))
    const openCodeDbPath = join(dir, 'opencode.db')
    discovery.dbPaths = { 'kilocode-db': join(dir, 'kilo.db') }

    await runParse(cache, undefined, { openCodeDbPath })
    expect(count('opencode')).toBe(2)
    expect(count('kilocode')).toBe(1)

    // Later runs: a Kilo message newer than everything, then an OpenCode
    // message older than it.
    putMessage(kilo, 'kilo_2', 9000, assistant(900, 90))
    await runParse(cache, undefined, { openCodeDbPath })
    putMessage(opencode, 'oc_3', 5000, assistant(500, 50))
    await runParse(cache, undefined, { openCodeDbPath })

    expect(count('opencode')).toBe(3)
    expect(count('kilocode')).toBe(2)
  })

  it('reads only the databases it is given, whatever the environment points at', async () => {
    const kilo = sourceDb('kilo.db', MESSAGE_SCHEMA)
    putMessage(kilo, 'kilo_1', 2000, assistant(200, 20))
    const other = sourceDb('other-kilo.db', MESSAGE_SCHEMA)
    putMessage(other, 'other_1', 1000, assistant(100, 10))
    putMessage(other, 'other_2', 2000, assistant(200, 20))
    discovery.dbPaths = { 'kilocode-db': join(dir, 'kilo.db') }
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'kilocode-db': join(dir, 'kilo.db') } }))
    vi.stubEnv('AIUSAGE_KILOCODE_DB_PATH', join(dir, 'other-kilo.db'))

    await runParse(cache)

    expect(cache.prepare('SELECT tool, COUNT(*) AS n FROM records GROUP BY tool').all()).toEqual([{ tool: 'kilocode', n: 1 }])
  })

  it.each([
    ['opencode', 'opencode.db'],
    ['kilocode', 'kilo.db'],
  ])('keeps the pending messages of %s between runs', async (tool, name) => {
    const source = sourceDb(name, MESSAGE_SCHEMA)
    putMessage(source, 'msg_1', 1000, assistant(0, 0, null))
    putMessage(source, 'msg_2', 2000, '{not json')
    putMessage(source, 'msg_3', 3000, assistant(300, 30))
    const options = tool === 'opencode' ? { openCodeDbPath: join(dir, name) } : {}
    if (tool === 'kilocode') discovery.dbPaths = { 'kilocode-db': join(dir, name) }
    const tokens = () => cache.prepare('SELECT input_tokens FROM records WHERE tool = ? ORDER BY input_tokens').pluck().all(tool)

    await runParse(cache, undefined, options)
    expect(tokens()).toEqual([300])

    // Both finish after the cursor has moved past them.
    putMessage(source, 'msg_1', 1000, assistant(100, 10))
    putMessage(source, 'msg_2', 2000, assistant(200, 20))
    await runParse(cache, undefined, options)

    expect(tokens()).toEqual([100, 200, 300])
  })

  it('replaces the tool calls of an OpenCode message that is read again', async () => {
    const opencode = sourceDb('opencode.db', MESSAGE_SCHEMA)
    // Has tokens but is not complete, so it is read again.
    putMessage(opencode, 'msg_1', 1000, assistant(100, 10, null))
    const putPart = (id: string, timeCreated: number, data: string) =>
      opencode.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(id, 'msg_1', 'sess', timeCreated, data)
    putPart('part_1', 1001, '{not json')
    putPart('part_2', 1002, JSON.stringify({ type: 'tool', tool: 'read' }))
    const options = { openCodeDbPath: join(dir, 'opencode.db') }
    const calls = () => cache.prepare('SELECT name, call_index FROM tool_calls ORDER BY call_index').all()

    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'read', call_index: 0 }])

    // The earlier part becomes readable: the call that was stored moves up.
    putPart('part_1', 1001, JSON.stringify({ type: 'tool', tool: 'write' }))
    await runParse(cache, undefined, options)

    expect(calls()).toEqual([{ name: 'write', call_index: 0 }, { name: 'read', call_index: 1 }])
  })

  it('replaces the tool calls of a Hermes session that is read again', async () => {
    const hermes = sourceDb('state.db', HERMES_SCHEMA)
    hermes.prepare('INSERT INTO sessions (id, model, started_at, ended_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)').run('open', 'gpt-4o', 100, null, 1000, 100)
    const putCalls = (id: number, toolCalls: string) =>
      hermes.prepare('INSERT OR REPLACE INTO messages (id, session_id, role, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, 'open', 'assistant', toolCalls, 100 + id)
    putCalls(1, '{not json')
    putCalls(2, JSON.stringify([{ function: { name: 'read' } }]))
    const options = { hermesDbPath: join(dir, 'state.db') }
    const calls = () => cache.prepare('SELECT name, call_index FROM tool_calls ORDER BY call_index').all()

    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'read', call_index: 0 }])

    putCalls(1, JSON.stringify([{ function: { name: 'write' } }]))
    await runParse(cache, undefined, options)

    expect(calls()).toEqual([{ name: 'write', call_index: 0 }, { name: 'read', call_index: 1 }])
  })

  it('keeps the stored tool calls of an OpenCode message whose part cannot be read, and reads it again', async () => {
    const opencode = sourceDb('opencode.db', MESSAGE_SCHEMA)
    putMessage(opencode, 'msg_1', 1000, assistant(100, 10, null))
    const putPart = (id: string, timeCreated: number, data: string) =>
      opencode.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(id, 'msg_1', 'sess', timeCreated, data)
    putPart('part_1', 1001, JSON.stringify({ type: 'tool', tool: 'read' }))
    putPart('part_2', 1002, JSON.stringify({ type: 'tool', tool: 'write' }))
    const options = { openCodeDbPath: join(dir, 'opencode.db') }
    const calls = () => cache.prepare('SELECT name, call_index FROM tool_calls ORDER BY call_index').all()
    const stored = [{ name: 'read', call_index: 0 }, { name: 'write', call_index: 1 }]

    await runParse(cache, undefined, options)
    expect(calls()).toEqual(stored)

    // The message becomes final on the very read on which a part cannot be
    // read: the calls read now are short of one.
    putMessage(opencode, 'msg_1', 1000, assistant(900, 90))
    putPart('part_1', 1001, '{not json')
    const result = await runParse(cache, undefined, options)

    expect(result.errors.some(e => e.includes('part_1'))).toBe(true)
    expect(cache.prepare('SELECT input_tokens FROM records').pluck().all()).toEqual([900])
    expect(calls()).toEqual(stored)

    // Unreadable in other ways: still nothing is taken away or added.
    for (const data of ['null', '[]']) {
      putPart('part_1', 1001, data)
      await runParse(cache, undefined, options)
      expect(calls()).toEqual(stored)
    }

    // The message is final, and it is still read again: once the part can
    // be read, the calls are replaced by what the message holds now.
    putPart('part_1', 1001, JSON.stringify({ type: 'tool', tool: 'grep' }))
    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'grep', call_index: 0 }, { name: 'write', call_index: 1 }])

    // Read in full: it is not read again.
    putPart('part_3', 1003, JSON.stringify({ type: 'tool', tool: 'bash' }))
    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'grep', call_index: 0 }, { name: 'write', call_index: 1 }])
  })

  it('keeps the stored tool calls of a Hermes session whose tool calls cannot be read, and reads it again', async () => {
    const hermes = sourceDb('state.db', HERMES_SCHEMA)
    const putSession = (id: string, startedAt: number, endedAt: number | null, input: number) =>
      hermes.prepare('INSERT OR REPLACE INTO sessions (id, model, started_at, ended_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'gpt-4o', startedAt, endedAt, input, 100)
    const putCalls = (id: number, toolCalls: string) =>
      hermes.prepare('INSERT OR REPLACE INTO messages (id, session_id, role, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, 'slow', 'assistant', toolCalls, 10 + id)
    putSession('slow', 10, null, 1000)
    putSession('fast', 20, 30, 10)
    putCalls(1, JSON.stringify([{ function: { name: 'read' } }]))
    putCalls(2, JSON.stringify([{ function: { name: 'write' } }]))
    const options = { hermesDbPath: join(dir, 'state.db') }
    const calls = () => cache.prepare('SELECT name, call_index FROM tool_calls ORDER BY call_index').all()
    const stored = [{ name: 'read', call_index: 0 }, { name: 'write', call_index: 1 }]

    await runParse(cache, undefined, options)
    expect(calls()).toEqual(stored)

    // The session ends, behind the cursor, on the very read on which one of
    // its payloads cannot be read.
    putSession('slow', 10, 25, 9000)
    putCalls(1, '{not json')
    const result = await runParse(cache, undefined, options)

    expect(result.errors.some(e => e.includes('session slow message 1'))).toBe(true)
    expect(cache.prepare("SELECT input_tokens FROM records WHERE session_id = 'slow'").pluck().all()).toEqual([9000])
    expect(calls()).toEqual(stored)

    // Not an array: unreadable in another way.
    putCalls(1, '{}')
    await runParse(cache, undefined, options)
    expect(calls()).toEqual(stored)

    // The session has ended, and it is still read again.
    putCalls(1, JSON.stringify([{ function: { name: 'grep' } }, null]))
    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'grep', call_index: 0 }, { name: 'write', call_index: 1 }])

    // Read in full: it is not read again.
    putCalls(3, JSON.stringify([{ function: { name: 'bash' } }]))
    await runParse(cache, undefined, options)
    expect(calls()).toEqual([{ name: 'grep', call_index: 0 }, { name: 'write', call_index: 1 }])
  })

  it('does not replace a stored Cursor total with one that is short of a bubble', async () => {
    const cursorDb = sourceDb('state.vscdb', CURSOR_SCHEMA)
    const put = (key: string, value: unknown) =>
      cursorDb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, typeof value === 'string' ? value : JSON.stringify(value))
    const composer = (id: string, createdAt: number) => put(`composerData:${id}`, {
      _v: 3, composerId: id, createdAt, usageData: {}, fullConversationHeadersOnly: [], conversationMap: {}, status: 'none',
    })
    const bubble = (inputTokens: number) => ({ type: 2, tokenCount: { inputTokens, outputTokens: 1 } })
    composer('conv', 1_779_400_000_000)
    put('bubbleId:conv:b1', bubble(100))
    put('bubbleId:conv:b2', bubble(200))
    const options = { cursorDbPath: join(dir, 'state.vscdb') }
    const target = 'cloud:https://sync.example.test'
    const rows = () => cache.prepare("SELECT id, session_id, input_tokens, updated_at FROM records WHERE tool = 'cursor' ORDER BY ts").all() as Array<{ id: string; session_id: string; input_tokens: number; updated_at: number }>

    await runParse(cache, undefined, options)
    const first = rows()
    expect(first.map(r => r.input_tokens)).toEqual([300])
    markRecordVersionsSynced(cache, first.map(r => ({ id: r.id, updatedAt: r.updated_at })), target)

    // One bubble cannot be read any more; a new conversation has one too.
    put('bubbleId:conv:b2', '{not json')
    composer('fresh', 1_779_410_000_000)
    put('bubbleId:fresh:b1', bubble(50))
    put('bubbleId:fresh:b2', 'null')
    const second = await runParse(cache, undefined, options)
    // Unreadable in another way: valid JSON that is not a bubble.
    put('bubbleId:conv:b2', '[]')
    await runParse(cache, undefined, options)

    // The stored total stands and stays synced; the conversation without a
    // record gets what could be read. Both are reported.
    expect(rows()).toEqual([first[0], expect.objectContaining({ session_id: 'fresh', input_tokens: 50 })])
    expect(getUnsyncedRecords(cache, target, DEVICE).map(r => r.sessionId)).toEqual(['fresh'])
    expect(second.errors).toHaveLength(2)

    // Readable again, with more usage: the record follows.
    put('bubbleId:conv:b2', bubble(900))
    await runParse(cache, undefined, options)
    expect(rows().map(r => r.input_tokens)).toEqual([1000, 50])
  })

  it('reads a Goose session again on every run and leaves an unchanged one synced', async () => {
    const goose = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(goose, 's1', '2026-07-06 08:00:00', 1000, 100)
    discovery.dbPaths = { goose: join(dir, 'sessions.db') }
    const target = 'cloud:https://sync.example.test'
    const row = () => cache.prepare("SELECT id, input_tokens, output_tokens, updated_at FROM records WHERE tool = 'goose'").get() as { id: string; input_tokens: number; output_tokens: number; updated_at: number }

    await runParse(cache, 'goose')
    const first = row()
    expect(first).toMatchObject({ input_tokens: 1000, output_tokens: 100 })
    markRecordVersionsSynced(cache, [{ id: first.id, updatedAt: first.updated_at }], target)

    // Nothing changed: the row is read again and stays synced.
    await runParse(cache, 'goose')
    expect(row()).toEqual(first)
    expect(getUnsyncedRecords(cache, target, DEVICE)).toEqual([])

    // The session went on: the record follows and is queued again.
    goose.prepare('UPDATE sessions SET accumulated_input_tokens = 5000, accumulated_output_tokens = 500, accumulated_total_tokens = 5500 WHERE id = ?').run('s1')
    await runParse(cache, 'goose')
    expect(row()).toMatchObject({ id: first.id, input_tokens: 5000, output_tokens: 500 })
    expect(getUnsyncedRecords(cache, target, DEVICE).map(r => r.id)).toEqual([first.id])
  })

  it('imports a Goose session without a readable creation time once it has usage, and follows it as one record', async () => {
    const goose = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(goose, 's0', 'not a date', 10, 1)
    putGooseSession(goose, 's1', 'not a date', 0, 0)
    discovery.dbPaths = { goose: join(dir, 'sessions.db') }
    const target = 'cloud:https://sync.example.test'
    const rows = () => cache.prepare("SELECT id, ts, session_id, input_tokens, updated_at FROM records WHERE tool = 'goose' ORDER BY session_id").all() as { id: string; ts: number; session_id: string; input_tokens: number; updated_at: number }[]
    const setUsage = goose.prepare('UPDATE sessions SET accumulated_input_tokens = ?, accumulated_output_tokens = 10, accumulated_total_tokens = ? + 10 WHERE id = ?')

    // No usage yet: nothing is stored for s1, and the cursor has passed it.
    await runParse(cache, 'goose')
    expect(rows().map(r => r.session_id)).toEqual(['s0'])

    setUsage.run(100, 100, 's1')
    await runParse(cache, 'goose')
    const first = rows()
    expect(first.map(r => [r.session_id, r.input_tokens])).toEqual([['s0', 10], ['s1', 100]])
    markRecordVersionsSynced(cache, first.map(r => ({ id: r.id, updatedAt: r.updated_at })), target)

    // Nothing changed: no second record, although the import time moved on.
    await new Promise(resolve => setTimeout(resolve, 5))
    await runParse(cache, 'goose')
    expect(rows()).toEqual(first)
    expect(getUnsyncedRecords(cache, target, DEVICE)).toEqual([])

    setUsage.run(500, 500, 's1')
    await runParse(cache, 'goose')
    expect(rows().map(r => [r.id, r.ts, r.input_tokens])).toEqual([
      [first[0].id, first[0].ts, 10],
      [first[1].id, first[1].ts, 500],
    ])
    expect(getUnsyncedRecords(cache, target, DEVICE).map(r => r.id)).toEqual([first[1].id])
  })

  it.each([
    ['gets a readable creation time', 'not a date', '2026-07-06 08:00:00'],
    ['loses its readable creation time', '2026-07-06 08:00:00', 'not a date'],
  ])('keeps one record for a Goose session that %s', async (_name, before, after) => {
    const goose = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(goose, 's0', before, 100, 10)
    discovery.dbPaths = { goose: join(dir, 'sessions.db') }
    const rows = () => cache.prepare("SELECT id, ts, input_tokens, updated_at FROM records WHERE tool = 'goose'").all() as { id: string; ts: number; input_tokens: number; updated_at: number }[]

    await runParse(cache, 'goose')
    const first = rows()
    expect(first.map(r => r.input_tokens)).toEqual([100])

    goose.prepare('UPDATE sessions SET created_at = ?, accumulated_input_tokens = 500, accumulated_total_tokens = 510 WHERE id = ?').run(after, 's0')
    await runParse(cache, 'goose')
    const second = rows()
    expect(second.map(r => [r.id, r.ts, r.input_tokens])).toEqual([[first[0].id, first[0].ts, 500]])

    await new Promise(resolve => setTimeout(resolve, 5))
    await runParse(cache, 'goose')
    expect(rows()).toEqual(second)
  })
})

const GOOSE_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, model_config_json TEXT, provider_name TEXT, created_at TEXT,
    total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER
  );
`

function putGooseSession(db: Database.Database, id: string, createdAt: string, input: number, output: number): void {
  db.prepare(`
    INSERT INTO sessions (id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens,
      accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens)
    VALUES (?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, JSON.stringify({ model_name: 'gpt-4o' }), createdAt, input + output, input, output, input + output, input, output)
}

describe('Goose import (#83)', () => {
  const run = (db: Database.Database, cursor: any, now = NOW) => runParseGoose(db, { ...BASE, now, dbPath: '/data/sessions.db', cursor })

  it('follows a session whose totals grow after the first import', () => {
    const db = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(db, 's1', '2026-07-06 08:00:00', 1000, 100)
    putGooseSession(db, 's2', '2026-07-06 09:00:00', 10, 1)

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([1000, 10])
    expect(first.nextCursor).toEqual({ lastCreatedAt: '2026-07-06 09:00:00', lastId: 's2' })

    db.prepare('UPDATE sessions SET accumulated_input_tokens = 5000, accumulated_output_tokens = 500 WHERE id = ?').run('s1')
    const second = run(db, first.nextCursor, NOW + 1000)

    expect(second.records.map(r => [r.id, r.inputTokens])).toEqual([
      [first.records[0].id, 5000],
      [first.records[1].id, 10],
    ])
  })

  it('reads a session whose creation time cannot be read on every run', () => {
    const db = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(db, 's1', 'not a date', 1000, 100)

    const first = run(db, null)
    expect(first.records.map(r => [r.sessionId, r.ts])).toEqual([['s1', NOW]])

    // Its record id and time are built from the import time: the caller
    // matches it to the record it has stored by session id.
    const second = run(db, first.nextCursor, NOW + 1000)
    expect(second.records.map(r => [r.sessionId, r.ts])).toEqual([['s1', NOW + 1000]])
    expect(second.records[0].id).not.toBe(first.records[0].id)
  })
})

const HERMES_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT, started_at REAL NOT NULL, ended_at REAL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL, title TEXT
  );
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, tool_calls TEXT, timestamp REAL NOT NULL);
`

describe('Hermes import (#83)', () => {
  const run = (db: Database.Database, cursor: any) => runParseHermes(db, { ...BASE, dbPath: '/data/state.db', cursor })
  const put = (db: Database.Database, id: string, startedAt: number, endedAt: number | null, input: number, output: number) =>
    db.prepare('INSERT OR REPLACE INTO sessions (id, model, started_at, ended_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'gpt-4o', startedAt, endedAt, input, output)

  it('follows a session that is still open', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'open', 100, null, 1000, 100)

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([1000])
    expect(first.nextCursor).toEqual({ lastEndedAt: 100, lastId: 'open', openSessionIds: ['open'] })

    put(db, 'open', 100, null, 5000, 500)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.id, r.inputTokens])).toEqual([[first.records[0].id, 5000]])
  })

  it('reads a session once more when it ended at a time the cursor has passed', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'slow', 10, null, 1000, 100)
    put(db, 'fast', 20, 30, 10, 1)
    const first = run(db, null)
    expect(first.nextCursor).toEqual({ lastEndedAt: 30, lastId: 'fast', openSessionIds: ['slow'] })

    // Ends before the newest session did, with its final totals.
    put(db, 'slow', 10, 25, 9000, 900)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.sessionId, r.inputTokens])).toEqual([['slow', 9000]])
    // The cursor did not move back, and nothing is left to read again.
    expect(second.nextCursor).toEqual({ lastEndedAt: 30, lastId: 'fast', openSessionIds: [] })
    expect(run(db, second.nextCursor).records).toEqual([])
  })

  it('reads a session that had no usage while it was open, once it has ended behind the cursor', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    // Nothing to import for it yet.
    put(db, 'slow', 10, null, 0, 0)
    put(db, 'fast', 20, 30, 10, 1)
    const first = run(db, null)
    expect(first.records.map(r => r.sessionId)).toEqual(['fast'])
    expect(first.nextCursor).toEqual({ lastEndedAt: 30, lastId: 'fast', openSessionIds: ['slow'] })

    put(db, 'slow', 10, 25, 9000, 900)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.sessionId, r.inputTokens])).toEqual([['slow', 9000]])
    expect(second.nextCursor).toEqual({ lastEndedAt: 30, lastId: 'fast', openSessionIds: [] })
  })

  it('tracks an open session without usage when nothing else is read, and forgets it when it is deleted', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'done', 10, 20, 1000, 100)
    const first = run(db, null)

    put(db, 'idle', 30, null, 0, 0)
    const second = run(db, first.nextCursor)
    expect(second.records).toEqual([])
    expect(second.nextCursor).toEqual({ lastEndedAt: 20, lastId: 'done', openSessionIds: ['idle'] })

    db.prepare('DELETE FROM sessions WHERE id = ?').run('idle')
    expect(run(db, second.nextCursor).nextCursor).toEqual({ lastEndedAt: 20, lastId: 'done', openSessionIds: [] })
  })

  it('reads the sessions and the open sessions in one transaction', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'open', 100, null, 1000, 100)
    const prepare = db.prepare.bind(db)
    const inTransaction: boolean[] = []
    db.prepare = ((sql: string) => {
      inTransaction.push(db.inTransaction)
      return prepare(sql)
    }) as typeof db.prepare

    run(db, null)

    expect(inTransaction.length).toBeGreaterThan(1)
    expect(inTransaction).not.toContain(false)
    expect(db.inTransaction).toBe(false)
  })

  it('does not read ended sessions behind the cursor again', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'done', 10, 20, 1000, 100)
    const first = run(db, null)

    const second = run(db, first.nextCursor)

    expect(second.records).toEqual([])
    expect(second.nextCursor).toBeNull()
  })

  it('reads every session once more for a cursor written before open sessions were tracked', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'done', 10, 20, 1000, 100)
    put(db, 'open', 7, null, 300, 30)
    // Imported while open by the earlier release, which then moved its
    // cursor to 'done'; it ended before the upgrade, behind that cursor.
    put(db, 'late', 5, 15, 9000, 900)

    const result = run(db, { lastEndedAt: 20, lastId: 'done' })

    expect(result.records.map(r => [r.sessionId, r.inputTokens])).toEqual([['open', 300], ['late', 9000], ['done', 1000]])
    expect(result.nextCursor).toEqual({ lastEndedAt: 20, lastId: 'done', openSessionIds: ['open'] })
    // Once: the cursor now tracks open sessions.
    expect(run(db, result.nextCursor).records.map(r => r.sessionId)).toEqual(['open'])
  })

  it('gives a cursor written before open sessions were tracked its list even when there is nothing to read', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)

    const result = run(db, { lastEndedAt: 20, lastId: 'done' })

    expect(result.records).toEqual([])
    expect(result.nextCursor).toEqual({ lastEndedAt: 20, lastId: 'done', openSessionIds: [] })
    expect(run(db, result.nextCursor).nextCursor).toBeNull()
  })
})

const CURSOR_SCHEMA = 'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);'

describe('Cursor import (#83)', () => {
  const run = (db: Database.Database, cursor: any) => runParseCursor(db, { ...BASE, dbPath: '/data/state.vscdb', cursor })
  const putComposer = (db: Database.Database, id: string, createdAt: number, extra: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`composerData:${id}`, JSON.stringify({
      _v: 3, composerId: id, createdAt, usageData: {}, fullConversationHeadersOnly: [], conversationMap: {}, status: 'none', ...extra,
    }))
  const putBubble = (db: Database.Database, composerId: string, bubbleId: string, input: number, output: number) =>
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`bubbleId:${composerId}:${bubbleId}`, JSON.stringify({
      type: 2, tokenCount: { inputTokens: input, outputTokens: output },
    }))
  const putBubbleWithoutTokens = (db: Database.Database, composerId: string, bubbleId: string) =>
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`bubbleId:${composerId}:${bubbleId}`, JSON.stringify({ type: 2 }))

  it('follows a conversation that gains a bubble', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'old', 1_779_400_000_000)
    putBubble(db, 'old', 'b1', 1000, 100)
    putComposer(db, 'new', 1_779_410_000_000)
    putBubble(db, 'new', 'b1', 10, 1)

    const first = run(db, null)
    expect(first.records.map(r => [r.sessionId, r.inputTokens])).toEqual([['old', 1000], ['new', 10]])

    // The older conversation continues after a newer one exists.
    putBubble(db, 'old', 'b2', 2000, 200)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.id, r.inputTokens, r.outputTokens])).toEqual([
      [first.records[0].id, 3000, 300],
      [first.records[1].id, 10, 1],
    ])
  })

  it('imports token counts that arrive on a bubble it has already seen', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'waiting', 1_779_400_000_000)
    putBubbleWithoutTokens(db, 'waiting', 'b1')
    putComposer(db, 'growing', 1_779_410_000_000)
    putBubble(db, 'growing', 'b1', 1000, 0)

    const first = run(db, null)
    // Nothing to import yet for the first conversation.
    expect(first.records.map(r => [r.sessionId, r.inputTokens, r.outputTokens])).toEqual([['growing', 1000, 0]])

    // The same bubbles get their counts. No bubble is added and nothing in
    // either composerData entry changes.
    putBubble(db, 'waiting', 'b1', 500, 50)
    putBubble(db, 'growing', 'b1', 1000, 400)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.sessionId, r.inputTokens, r.outputTokens])).toEqual([
      ['waiting', 500, 50],
      ['growing', 1000, 400],
    ])
    expect(second.records[1].id).toBe(first.records[0].id)
  })

  it('sets the record of a conversation with an unreadable bubble apart and reports it', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'whole', 1_779_400_000_000)
    putBubble(db, 'whole', 'b1', 1000, 100)
    putBubbleWithoutTokens(db, 'whole', 'b2')
    putComposer(db, 'short', 1_779_410_000_000)
    putBubble(db, 'short', 'b1', 100, 10)
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:short:b2', '{not json')

    const result = run(db, null)

    expect(result.records.map(r => [r.sessionId, r.inputTokens])).toEqual([['whole', 1000]])
    expect(result.partialRecords.map(r => [r.sessionId, r.inputTokens])).toEqual([['short', 100]])
    expect(result.errors).toEqual(['composerId short: 1 of 2 bubbles could not be read'])
  })

  it('reads every conversation for a cursor written by an earlier release', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'old', 1_779_400_000_000)
    putBubble(db, 'old', 'b1', 1000, 100)
    putBubble(db, 'old', 'b2', 2000, 200)
    putComposer(db, 'new', 1_779_410_000_000)
    putBubble(db, 'new', 'b1', 10, 1)

    const result = run(db, { lastCreatedAt: 1_779_410_000_000, lastId: 'new' })

    expect(result.records.map(r => r.inputTokens)).toEqual([3000, 10])
    // The cursor already names the newest conversation: nothing to store.
    expect(result.nextCursor).toBeNull()
  })

  it('keeps nothing per conversation in the cursor', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'gone', 1_779_400_000_000)
    putBubble(db, 'gone', 'b1', 1000, 100)
    putComposer(db, 'empty', 1_779_405_000_000)
    const first = run(db, null)
    expect(first.nextCursor).toEqual({ lastCreatedAt: 1_779_405_000_000, lastId: 'empty' })

    db.prepare("DELETE FROM cursorDiskKV WHERE key LIKE '%gone%'").run()
    const second = run(db, first.nextCursor)

    expect(second.records).toEqual([])
    expect(second.nextCursor).toBeNull()
  })
})

describe('Trae import (#84)', () => {
  function makeSnapshotRepo(repoPath: string, tags: Array<{ name: string; ts: number }>): void {
    mkdirSync(repoPath, { recursive: true })
    const git = (args: string[], ts?: number) => {
      const env = { ...process.env }
      if (ts != null) {
        env.GIT_AUTHOR_DATE = `@${ts} +0000`
        env.GIT_COMMITTER_DATE = `@${ts} +0000`
      }
      const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8', env })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    }
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    git(['config', 'commit.gpgsign', 'false'])
    for (const { name, ts } of tags) {
      git(['commit', '--allow-empty', '-q', '-m', name], ts)
      git(['tag', name])
    }
  }

  it('imports a session that started before one visited earlier, and follows new turns', () => {
    const globalStorage = join(dir, 'User', 'globalStorage')
    mkdirSync(globalStorage, { recursive: true })
    const dbPath = join(globalStorage, 'state.vscdb')
    writeFileSync(dbPath, '')
    const snapshotDir = join(dir, 'ModularData', 'ai-agent', 'snapshot')
    const first = 'a'.repeat(24)
    const second = 'b'.repeat(24)
    const day = 86_400
    const start = 1_700_000_000
    // The directory that sorts first started a day later.
    makeSnapshotRepo(join(snapshotDir, first, 'v2'), [
      { name: `chain-start-${first}`, ts: start + day },
      { name: 'before-chat-turn-1', ts: start + day + 10 },
      { name: 'before-chat-turn-2', ts: start + day + 20 },
    ])
    makeSnapshotRepo(join(snapshotDir, second, 'v2'), [
      { name: `chain-start-${second}`, ts: start },
      { name: 'before-chat-turn-1', ts: start + 10 },
      { name: 'before-chat-turn-2', ts: start + 20 },
    ])
    const run = (lastImportedAt: number) => runParseTrae({ ...BASE, dbPath, lastImportedAt })

    const one = run(0)
    expect(one.records.map(r => [r.sessionId, r.ts])).toEqual([[second, start * 1000], [first, (start + day) * 1000]])
    expect(one.lastImportedAt).toBe((start + day) * 1000)

    // The earlier session gains a turn after the later one was imported.
    makeSnapshotRepo(join(snapshotDir, second, 'v2'), [{ name: 'before-chat-turn-3', ts: start + 30 }])
    const two = run(one.lastImportedAt)

    expect(two.records.map(r => [r.id, r.outputTokens])).toEqual([
      [one.records[0].id, 3 * 800],
      [one.records[1].id, 2 * 800],
    ])
    expect(two.lastImportedAt).toBe(one.lastImportedAt)
  })
})
