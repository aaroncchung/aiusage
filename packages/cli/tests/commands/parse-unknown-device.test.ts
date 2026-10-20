import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { initializeDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'
import { createApiServer } from '../../src/api/server.js'
import { createKelivoDatabaseFile } from '../helpers/kelivo-fixture.js'
import { createAntigravitySchema, seedAntigravityGenerations } from '../helpers/antigravity-fixture.js'

// Before v1.5.22 only setting up sync wrote state.json, so an installation
// without sync parsed every source under the device id 'unknown', and record
// ids are built from the device id. v1.5.22 writes state.json with a real
// device id before every command and relabels those rows, keeping their ids.
// Each test below parses a source with no state.json, gives the installation
// its device id, makes the source be read again the way one path of the
// importer does, and checks that the record is not stored a second time.
// tests/setup-home.ts gives this file its own home directory.

const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const DEVICE = '11111111-2222-3333-4444-555555555555'

let db: Database.Database
let src: string

beforeEach(() => {
  rmSync(aiusageDir, { recursive: true, force: true })
  mkdirSync(aiusageDir, { recursive: true })
  src = mkdtempSync(join(tmpdir(), 'aiu-unknown-'))
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

/** What every command of v1.5.22 and later does first. */
function giveDevice(): void {
  writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE, lastSyncStatus: 'ok' }))
}

/** The watermark as a release before `field` existed wrote it. */
function dropWatermarkField(field: string): void {
  const watermark = JSON.parse(readFileSync(watermarkPath, 'utf-8'))
  delete watermark[field]
  writeFileSync(watermarkPath, JSON.stringify(watermark))
}

function records(tool: string): Array<{ id: string; input_tokens: number; output_tokens: number; device_instance_id: string }> {
  return db.prepare('SELECT id, input_tokens, output_tokens, device_instance_id FROM records WHERE tool = ? ORDER BY ts, id').all(tool) as Array<{ id: string; input_tokens: number; output_tokens: number; device_instance_id: string }>
}

function ids(tool: string): string[] {
  return records(tool).map(r => r.id)
}

function jsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
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

describe('a source read again after the installation got its device id', () => {
  it('Claude Code: the one-time re-import keeps one record per message', async () => {
    configure({ 'claude-code': src })
    jsonl(join(src, 'proj', 's.jsonl'), [
      claudeLine('m1', '2026-09-01T00:00:00Z', 5, 'b1'),
      claudeLine('m2', '2026-09-01T00:01:00Z', 7, 'b2'),
    ])
    await runParse(db, 'claude-code')
    const before = ids('claude-code')
    expect(before).toHaveLength(2)

    // Upgrading from a release before the Claude Code re-import.
    dropWatermarkField('claudeCodeParserVersion')
    giveDevice()
    await runParse(db, 'claude-code')

    expect(ids('claude-code')).toEqual(before)
    expect(records('claude-code').every(r => r.device_instance_id === DEVICE)).toBe(true)
    // The re-import restores the calls under the stored record, not a copy.
    expect(db.prepare('SELECT DISTINCT record_id FROM tool_calls ORDER BY record_id').all().map((r: any) => r.record_id)).toEqual([...before].sort())
  })

  it('Claude Code: a message whose lines straddle the watermark stays one record', async () => {
    configure({ 'claude-code': src })
    const file = join(src, 'proj', 's.jsonl')
    jsonl(file, [
      claudeLine('m1', '2026-09-01T00:00:00Z', 5, 'b1'),
      claudeLine('m2', '2026-09-01T00:01:00Z', 7, 'b2'),
    ])
    await runParse(db, 'claude-code')
    const before = ids('claude-code')

    giveDevice()
    // m2 gets another content block, then a new message starts.
    appendFileSync(file, [
      JSON.stringify(claudeLine('m2', '2026-09-01T00:01:05Z', 9, 'b3')),
      JSON.stringify(claudeLine('m3', '2026-09-01T00:02:00Z', 4, 'b4')),
    ].join('\n') + '\n')
    await runParse(db, 'claude-code')

    const after = records('claude-code')
    expect(after.map(r => r.id).slice(0, 2)).toEqual(before)
    expect(after.map(r => r.output_tokens)).toEqual([5, 9, 4])
  })

  it('CodeFuse: the one-time re-import keeps one record per message and per Codex turn', async () => {
    configure({ codefuse: src })
    jsonl(join(src, 'engine', 'cc', 'projects', '-ws', 'cc-session.jsonl'), [
      { type: 'user', sessionId: 'cc-session', cwd: '/ws' },
      {
        type: 'assistant', uuid: 'cc-uuid-1', sessionId: 'cc-session', timestamp: '2026-07-06T08:00:00.000Z',
        message: { id: 'msg-1', model: 'claude-opus-4-6', content: [], usage: { input_tokens: 100, output_tokens: 20 } },
      },
    ])
    jsonl(join(src, 'engine', 'codex', 'sessions', '2026', '07', '06', 'rollout-embedded.jsonl'), [
      { timestamp: '2026-07-06T08:01:01.000Z', type: 'event_msg', payload: { type: 'token_count', model: 'gpt-4o', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
    ])
    await runParse(db, 'codefuse')
    const before = ids('codefuse')
    expect(before).toHaveLength(2)

    dropWatermarkField('codefuseParserVersion')
    giveDevice()
    await runParse(db, 'codefuse')

    expect(ids('codefuse')).toEqual(before)
  })

  it('CodeFuse: a snapshot stored before the device id is replaced by its log', async () => {
    configure({ codefuse: src })
    const projectDir = join(src, 'engine', 'cc', 'projects', '-ws')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'ant_cc_s1.json'), JSON.stringify({
      session_id: 's1',
      model_id: 'glink/claude-opus-4-6',
      last_status_line: { context_window: { current_usage: { input_tokens: 5000, output_tokens: 500 } } },
      last_status_line_time: '2026-07-06T08:02:00.000Z',
    }))
    await runParse(db, 'codefuse')
    expect(ids('codefuse')).toHaveLength(1)

    giveDevice()
    jsonl(join(projectDir, 's1.jsonl'), [
      { type: 'user', sessionId: 's1', cwd: '/ws' },
      {
        type: 'assistant', uuid: 's1-uuid-1', sessionId: 's1', timestamp: '2026-07-06T08:00:00.000Z',
        message: { id: 'msg-s1', model: 'claude-opus-4-6', content: [], usage: { input_tokens: 100, output_tokens: 20 } },
      },
    ])
    await runParse(db, 'codefuse')

    // Only the log's record: the snapshot was a fallback for it.
    expect(records('codefuse').map(r => r.input_tokens)).toEqual([100])
  })

  it('Antigravity: the one-time re-import keeps one record per usage event', async () => {
    const dbPath = join(src, 'conversation.db')
    const conversation = new Database(dbPath)
    createAntigravitySchema(conversation)
    seedAntigravityGenerations(conversation, 2, 1, Date.parse('2026-09-01T00:00:00Z'))
    conversation.close()
    configure({ antigravity: dbPath })
    await runParse(db, 'antigravity')
    const before = ids('antigravity')
    expect(before).toHaveLength(4)

    dropWatermarkField('antigravityParserVersion')
    giveDevice()
    await runParse(db, 'antigravity')

    expect(ids('antigravity')).toEqual(before)
  })

  it('Kelivo: a newer backup keeps one record per message it already imported', async () => {
    configure({ kelivo: src })
    const message = (id: string, minute: number) => ({
      id, role: 'assistant', timestamp: `2026-06-05T10:0${minute}:00.000Z`, modelId: 'gpt-4o', providerId: 'openai',
      promptTokens: 100, completionTokens: 20, conversationId: 'c1',
    })
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [message('a1', 1)] }))
    await runParse(db, 'kelivo')
    const before = ids('kelivo')

    giveDevice()
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [message('a1', 1), message('a2', 2)] }))
    await runParse(db, 'kelivo')

    const after = ids('kelivo')
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
  })

  it('Kelivo: the app database keeps one record per message a backup imported', async () => {
    configure({ kelivo: src })
    writeFileSync(join(src, 'chats.json'), JSON.stringify({ messages: [{
      id: 'a1', role: 'assistant', timestamp: '2026-06-05T10:01:00.000Z', modelId: 'gpt-4o', providerId: 'openai',
      promptTokens: 100, completionTokens: 20, conversationId: 'c1',
    }] }))
    await runParse(db, 'kelivo')
    const before = ids('kelivo')

    giveDevice()
    // v1.5.23 also reads Kelivo's own database, which holds the same message.
    createKelivoDatabaseFile(join(src, 'kelivo.db'), [{
      id: 'a1', conversation_id: 'c1', role: 'assistant', timestamp: Date.parse('2026-06-05T10:01:00.000Z') * 1000,
      model_id: 'gpt-4o', provider_id: 'openai', prompt_tokens: 100, completion_tokens: 20,
    }]).close()
    await runParse(db, 'kelivo')

    expect(ids('kelivo')).toEqual(before)
  })

  it('Kelivo: a backup imported again from the dashboard keeps one record per message', async () => {
    const upload = async (deviceInstanceId: string | undefined) => {
      const server = createApiServer(db, { currentDeviceInstanceId: deviceInstanceId })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      try {
        const form = new FormData()
        form.append('file', new Blob([JSON.stringify({ messages: [{
          id: 'a1', role: 'assistant', timestamp: '2026-06-05T10:01:00.000Z', modelId: 'gpt-4o', providerId: 'openai',
          promptTokens: 100, completionTokens: 20, conversationId: 'c1',
        }] })], { type: 'application/json' }), 'chats.json')
        const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/import/kelivo`, { method: 'POST', body: form })
        expect(res.status).toBe(200)
        return await res.json()
      } finally {
        server.closeAllConnections?.()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
    // `aiusage serve` before v1.5.22 had no device id to pass on.
    await upload(undefined)
    const before = ids('kelivo')

    const second = await upload(DEVICE)

    expect(ids('kelivo')).toEqual(before)
    expect(second).toMatchObject({ imported: 1, added: 0 })
  })

  it('Roo Code: a task file that grows keeps one record per request', async () => {
    const tasks = join(src, 'tasks')
    configure({ roocode: tasks })
    const request = (ts: number) => ({ ts, say: 'api_req_started', text: JSON.stringify({ model: 'claude-sonnet-4-6', tokensIn: 100, tokensOut: 20 }) })
    mkdirSync(join(tasks, 'task-1'), { recursive: true })
    writeFileSync(join(tasks, 'task-1', 'ui_messages.json'), JSON.stringify([request(1778821880545)]))
    await runParse(db, 'roocode')
    const before = ids('roocode')

    giveDevice()
    writeFileSync(join(tasks, 'task-1', 'ui_messages.json'), JSON.stringify([request(1778821880545), request(1778821890545)]))
    await runParse(db, 'roocode')

    const after = ids('roocode')
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
  })

  it('Kiro: a session file that grows keeps one record per turn', async () => {
    const sessions = join(src, 'sessions')
    configure({ kiro: sessions })
    const turn = (rand: number, ts: number) => ({ loop_id: { rand }, request_start_timestamp_ms: ts, input_token_count: 400, output_token_count: 80 })
    const session = (turns: unknown[]) => JSON.stringify({
      session_id: 'kiro-session-1',
      session_state: { rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } }, conversation_metadata: { user_turn_metadatas: turns } },
    })
    mkdirSync(sessions, { recursive: true })
    const file = join(sessions, '11111111-1111-4111-8111-111111111111.json')
    writeFileSync(file, session([turn(1, 1778821880545)]))
    await runParse(db, 'kiro')
    const before = ids('kiro')

    giveDevice()
    writeFileSync(file, session([turn(1, 1778821880545), turn(2, 1778821890545)]))
    await runParse(db, 'kiro')

    const after = ids('kiro')
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
  })

  it('Zed: a thread updated later keeps one record', async () => {
    const dbPath = join(src, 'threads.db')
    const threads = new Database(dbPath)
    threads.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, data_type TEXT, data TEXT)')
    const thread = (input: number) => JSON.stringify({ model: { provider: 'anthropic', model: 'claude-sonnet-4' }, request_token_usage: [{ input_tokens: input, output_tokens: 30 }] })
    threads.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('t1', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z', 'json', thread(120))
    configure({ zed: dbPath })
    await runParse(db, 'zed')
    const before = ids('zed')

    giveDevice()
    threads.prepare('UPDATE threads SET updated_at = ?, data = ? WHERE id = ?').run('2026-05-01T11:00:00.000Z', thread(220), 't1')
    threads.close()
    await runParse(db, 'zed')

    expect(ids('zed')).toEqual(before)
    expect(records('zed')[0].input_tokens).toBe(220)
  })

  it('Codex: a lost watermark keeps one record per turn', async () => {
    configure({ codex: src })
    jsonl(join(src, 'rollout-a.jsonl'), [
      { type: 'event_msg', timestamp: '2026-07-06T09:00:00.000Z', payload: { type: 'token_count', model: 'gpt-5', info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } } } },
    ])
    await runParse(db, 'codex')
    const before = ids('codex')

    giveDevice()
    unlinkSync(watermarkPath)
    await runParse(db, 'codex')

    expect(ids('codex')).toEqual(before)
  })

  it('OpenCode: a lost watermark keeps one record per message', async () => {
    const dbPath = join(src, 'opencode.db')
    const opencode = new Database(dbPath)
    opencode.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    opencode.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg-1', 'ses-1', 1778821880545, JSON.stringify({
      role: 'assistant', modelID: 'glm-5.1', providerID: 'qianfan', cost: 0,
      tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1778821880545, completed: 1778821881545 },
    }))
    opencode.close()
    configure({})
    await runParse(db, 'opencode', { openCodeDbPath: dbPath })
    const before = ids('opencode')
    expect(before).toHaveLength(1)

    giveDevice()
    unlinkSync(watermarkPath)
    await runParse(db, 'opencode', { openCodeDbPath: dbPath })

    expect(ids('opencode')).toEqual(before)
  })
})
