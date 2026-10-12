import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, markRecordVersionsSynced } from '../../src/db/records.js'
import { runParse } from '../../src/commands/parse.js'
import { runParseOpenCode } from '../../src/commands/parse-opencode.js'
import { runParseKilo } from '../../src/commands/parse-kilo.js'
import { runParseGoose } from '../../src/commands/parse-goose.js'
import { runParseHermes } from '../../src/commands/parse-hermes.js'
import { runParseCursor } from '../../src/commands/parse-cursor.js'
import { runParseTrae } from '../../src/commands/parse-trae.js'

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
})

const MESSAGE_SCHEMA = `
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
`

function assistant(input: number, output: number, completed: number | null = 1): string {
  return JSON.stringify({
    role: 'assistant',
    modelID: 'gpt-4o',
    providerID: 'openai',
    cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    time: completed === null ? { created: 1 } : { created: 1, completed },
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
    expect(first.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 60_000, lastMessageId: 'msg_1' })

    putMessage(db, 'msg_2', NOW - 30_000, assistant(2000, 200))
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => [r.inputTokens, r.outputTokens])).toEqual([[2000, 200]])
    expect(second.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 30_000, lastMessageId: 'msg_2' })
    expect(run(db, second.nextCursor).records).toEqual([])
  })

  it('holds the cursor for a completed message without tokens and for one without a completion time', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(0, 0))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))

    const first = run(db, null)
    expect(first.records.map(r => r.inputTokens)).toEqual([500])
    expect(first.nextCursor).toBeNull()

    putMessage(db, 'msg_1', NOW - 60_000, assistant(700, 70, null))
    const second = run(db, first.nextCursor)
    // Tokens but no completion time: imported with what it has, still not final.
    expect(second.records.map(r => r.inputTokens)).toEqual([700, 500])
    expect(second.nextCursor).toBeNull()
  })

  it('keeps importing messages that follow an unfinished one, with stable ids', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, assistant(0, 0, null))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))

    const first = run(db, null)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => r.id)).toEqual(first.records.map(r => r.id))
  })

  it('stops waiting for a message that has been unfinished for a day', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    const dayAgo = NOW - 24 * 60 * 60 * 1000
    putMessage(db, 'msg_1', dayAgo, assistant(0, 0, null))
    putMessage(db, 'msg_2', NOW - 50_000, assistant(500, 50))

    const result = run(db, null)

    expect(result.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2' })
  })

  it('moves the cursor over user messages and unreadable rows', () => {
    const db = sourceDb('messages.db', MESSAGE_SCHEMA)
    putMessage(db, 'msg_1', NOW - 60_000, JSON.stringify({ role: 'user' }))
    putMessage(db, 'msg_2', NOW - 50_000, '{not json')

    const result = run(db, null)

    expect(result.records).toEqual([])
    expect(result.nextCursor).toEqual({ lastMessageCreatedAt: NOW - 50_000, lastMessageId: 'msg_2' })
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
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'kilocode-db': join(dir, 'kilo.db') } }))

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

  it('reads a Goose session again on every run and leaves an unchanged one synced', async () => {
    const goose = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(goose, 's1', '2026-07-06 08:00:00', 1000, 100)
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { goose: join(dir, 'sessions.db') } }))
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

  it('imports a session whose creation time cannot be read only once', () => {
    const db = sourceDb('sessions.db', GOOSE_SCHEMA)
    putGooseSession(db, 's1', 'not a date', 1000, 100)

    const first = run(db, null)
    expect(first.records).toHaveLength(1)

    // Its record id is built from the import time, so reading it again
    // would add a second record.
    expect(run(db, first.nextCursor, NOW + 1000).records).toEqual([])
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

  it('does not read ended sessions behind the cursor again', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'done', 10, 20, 1000, 100)
    const first = run(db, null)

    const second = run(db, first.nextCursor)

    expect(second.records).toEqual([])
    expect(second.nextCursor).toBeNull()
  })

  it('accepts a cursor written before open sessions were tracked', () => {
    const db = sourceDb('state.db', HERMES_SCHEMA)
    put(db, 'done', 10, 20, 1000, 100)
    put(db, 'open', 5, null, 300, 30)

    const result = run(db, { lastEndedAt: 20, lastId: 'done' })

    expect(result.records.map(r => r.sessionId)).toEqual(['open'])
    expect(result.nextCursor).toEqual({ lastEndedAt: 20, lastId: 'done', openSessionIds: ['open'] })
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

  it('reads a conversation again when it gains a bubble', () => {
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

    expect(second.records.map(r => [r.id, r.inputTokens, r.outputTokens])).toEqual([[first.records[0].id, 3000, 300]])
    expect(run(db, second.nextCursor).records).toEqual([])
  })

  it('reads a conversation again when Cursor marks it as updated', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'conv', 1_779_400_000_000, { lastUpdatedAt: 1_779_400_000_500, status: 'generating' })
    putBubble(db, 'conv', 'b1', 1000, 0)
    const first = run(db, null)

    // The bubble's tokens are filled in; the bubble count is the same.
    putBubble(db, 'conv', 'b1', 1000, 400)
    expect(run(db, first.nextCursor).records).toEqual([])
    putComposer(db, 'conv', 1_779_400_000_000, { lastUpdatedAt: 1_779_400_009_000, status: 'completed' })

    expect(run(db, first.nextCursor).records.map(r => r.outputTokens)).toEqual([400])
  })

  it('reads every conversation once more for a cursor written by an earlier release', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'old', 1_779_400_000_000)
    putBubble(db, 'old', 'b1', 1000, 100)
    putBubble(db, 'old', 'b2', 2000, 200)
    putComposer(db, 'new', 1_779_410_000_000)
    putBubble(db, 'new', 'b1', 10, 1)

    const result = run(db, { lastCreatedAt: 1_779_410_000_000, lastId: 'new' })

    expect(result.records.map(r => r.inputTokens)).toEqual([3000, 10])
    expect(result.nextCursor).toMatchObject({ lastCreatedAt: 1_779_410_000_000, lastId: 'new' })
    expect(Object.keys(result.nextCursor!.seen!).sort()).toEqual(['new', 'old'])
    expect(run(db, result.nextCursor).records).toEqual([])
  })

  it('forgets conversations that are gone and remembers ones without token data', () => {
    const db = sourceDb('state.vscdb', CURSOR_SCHEMA)
    putComposer(db, 'gone', 1_779_400_000_000)
    putBubble(db, 'gone', 'b1', 1000, 100)
    putComposer(db, 'empty', 1_779_405_000_000)
    const first = run(db, null)
    expect(Object.keys(first.nextCursor!.seen!).sort()).toEqual(['empty', 'gone'])

    db.prepare("DELETE FROM cursorDiskKV WHERE key LIKE '%gone%'").run()
    putComposer(db, 'next', 1_779_410_000_000)
    putBubble(db, 'next', 'b1', 10, 1)
    const second = run(db, first.nextCursor)

    expect(second.records.map(r => r.sessionId)).toEqual(['next'])
    expect(Object.keys(second.nextCursor!.seen!).sort()).toEqual(['empty', 'next'])
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
