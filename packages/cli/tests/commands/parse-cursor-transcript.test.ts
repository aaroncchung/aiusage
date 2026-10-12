import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { generateRecordId } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'

// tests/setup-home.ts gives this file its own home directory.
const aiusageDir = join(homedir(), '.aiusage')
const projectsDir = join(homedir(), '.cursor', 'projects')
const DEVICE = 'device-cursor-test'
const COMPOSER = '11111111-2222-3333-4444-555555555555'

interface Row {
  id: string
  ts: number
  input_tokens: number
  output_tokens: number
  source_file: string
  session_id: string
}

describe('runParse with Cursor agent transcripts', () => {
  let scratch: string
  let cursorDbPath: string
  let transcriptPath: string
  let db: Database.Database
  let clock: number

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aiu-cursor-tr-'))
    cursorDbPath = join(scratch, 'state.vscdb')
    rmSync(aiusageDir, { recursive: true, force: true })
    rmSync(projectsDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
    const transcriptDir = join(projectsDir, 'my-project', 'agent-transcripts', COMPOSER)
    mkdirSync(transcriptDir, { recursive: true })
    transcriptPath = join(transcriptDir, `${COMPOSER}.jsonl`)
    db = new Database(':memory:')
    initializeDatabase(db)
    clock = 1_780_000_000
  })

  afterEach(() => {
    db.close()
    rmSync(scratch, { recursive: true, force: true })
    rmSync(projectsDir, { recursive: true, force: true })
  })

  /** Append one message of `tokens` estimated tokens (3 characters each) and move the mtime forward. */
  function say(role: 'user' | 'assistant', tokens: number): number {
    const line = JSON.stringify({ role, message: { content: [{ type: 'text', text: 'a'.repeat(tokens * 3) }] } })
    appendFileSync(transcriptPath, line + '\n')
    clock += 60
    utimesSync(transcriptPath, clock, clock)
    return clock * 1000
  }

  /** Create or extend state.vscdb with one composer and, optionally, a bubble that has token counts. */
  function writeComposer(tokens: { input: number; output: number } | null, createdAt = 1_779_400_000_000): void {
    const cursorDb = new Database(cursorDbPath)
    cursorDb.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    const put = cursorDb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    put.run(`composerData:${COMPOSER}`, JSON.stringify({ composerId: COMPOSER, createdAt, padding: 'x'.repeat(120) }))
    put.run(`bubbleId:${COMPOSER}:b-1`, JSON.stringify(
      tokens ? { type: 2, tokenCount: { inputTokens: tokens.input, outputTokens: tokens.output } } : { type: 2 },
    ))
    cursorDb.close()
  }

  const rows = () => db.prepare(
    `SELECT id, ts, input_tokens, output_tokens, source_file, session_id FROM records WHERE tool = 'cursor' ORDER BY ts`,
  ).all() as Row[]

  const parse = () => runParse(db, 'cursor', { cursorDbPath })

  it('keeps one estimated record per transcript when the transcript grows (issue #80)', async () => {
    say('user', 100)
    say('assistant', 200)
    await parse()
    expect(rows().map(r => [r.input_tokens, r.output_tokens])).toEqual([[100, 200]])

    const mtime = say('assistant', 100)
    const result = await parse()
    expect(result.errors).toEqual([])
    const stored = rows()
    expect(stored.map(r => [r.input_tokens, r.output_tokens])).toEqual([[100, 300]])
    expect(stored[0].id).toBe(generateRecordId(DEVICE, transcriptPath, 0))
    expect(stored[0].ts).toBe(mtime)
  })

  it('does not parse an unchanged transcript again', async () => {
    say('user', 100)
    say('assistant', 200)
    await parse()
    const result = await parse()
    expect(result.parsedCount).toBe(0)
    expect(rows()).toHaveLength(1)
  })

  it('skips a transcript whose conversation is already counted from state.vscdb', async () => {
    writeComposer({ input: 5000, output: 200 })
    await parse()
    expect(rows().map(r => r.source_file)).toEqual([cursorDbPath])

    say('user', 100)
    say('assistant', 200)
    const result = await parse()
    expect(result.parsedCount).toBe(0)
    expect(rows().map(r => [r.source_file, r.input_tokens, r.output_tokens])).toEqual([[cursorDbPath, 5000, 200]])

    // Still skipped when it grows.
    say('assistant', 100)
    await parse()
    expect(rows()).toHaveLength(1)
  })

  it('counts a conversation once when the transcript and state.vscdb are first seen in the same run', async () => {
    writeComposer({ input: 5000, output: 200 })
    say('user', 100)
    say('assistant', 200)
    await parse()
    expect(rows().map(r => [r.source_file, r.input_tokens, r.output_tokens])).toEqual([[cursorDbPath, 5000, 200]])
  })

  it('drops the estimate once state.vscdb delivers token counts for the conversation', async () => {
    say('user', 100)
    say('assistant', 200)
    await parse()
    expect(rows().map(r => r.source_file)).toEqual([transcriptPath])

    writeComposer({ input: 5000, output: 200 })
    await parse()
    expect(rows().map(r => [r.source_file, r.input_tokens, r.output_tokens])).toEqual([[cursorDbPath, 5000, 200]])
  })

  it('keeps the estimate when state.vscdb has the conversation but no token counts (privacy mode)', async () => {
    writeComposer(null)
    say('user', 100)
    say('assistant', 200)
    await parse()
    say('assistant', 100)
    await parse()
    expect(rows().map(r => [r.source_file, r.input_tokens, r.output_tokens])).toEqual([[transcriptPath, 100, 300]])
  })

  it('keeps the stored estimate when part of the transcript can no longer be parsed', async () => {
    say('user', 100)
    say('assistant', 300)
    await parse()
    expect(rows().map(r => [r.input_tokens, r.output_tokens])).toEqual([[100, 300]])

    // The assistant line is damaged; the file is longer than before.
    const user = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(300) }] } })
    writeFileSync(transcriptPath, user + '\n' + '{"role":"assistant","message":{"content":[{"type":"text","text":"' + 'a'.repeat(1200) + '\n')
    clock += 60
    utimesSync(transcriptPath, clock, clock)
    const result = await parse()
    expect(result.parsedCount).toBe(0)
    expect(rows().map(r => [r.input_tokens, r.output_tokens])).toEqual([[100, 300]])
  })

  it('keeps the stored estimate when a partly unreadable transcript yields a larger total', async () => {
    say('user', 100)
    say('assistant', 300)
    await parse()

    // The assistant line is damaged and a long user message was added: 600 input, 0 output.
    const user = (tokens: number) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(tokens * 3) }] } })
    writeFileSync(transcriptPath, user(100) + '\n' + '{"role":"assistant","message":{"content":[{"type":"text","text":"' + 'a'.repeat(900) + '\n' + user(500) + '\n')
    clock += 60
    utimesSync(transcriptPath, clock, clock)
    const result = await parse()
    expect(result.parsedCount).toBe(0)
    expect(rows().map(r => [r.input_tokens, r.output_tokens])).toEqual([[100, 300]])
  })

  it('recognises state.vscdb records whatever the folder of the database is called', async () => {
    cursorDbPath = join(scratch, 'agent-transcripts-backup', 'state.vscdb')
    mkdirSync(join(scratch, 'agent-transcripts-backup'), { recursive: true })
    writeComposer({ input: 5000, output: 200 })
    await parse()
    say('user', 100)
    say('assistant', 200)
    await parse()
    say('assistant', 100)
    await parse()
    expect(rows().map(r => [r.source_file, r.input_tokens, r.output_tokens])).toEqual([[cursorDbPath, 5000, 200]])
  })

  it('keeps the estimate of another conversation', async () => {
    writeComposer({ input: 5000, output: 200 })
    const other = '99999999-8888-7777-6666-555555555555'
    const otherDir = join(projectsDir, 'my-project', 'agent-transcripts', other)
    mkdirSync(otherDir, { recursive: true })
    const otherPath = join(otherDir, `${other}.jsonl`)
    writeFileSync(otherPath, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(30) }] } }) + '\n')
    say('user', 100)
    await parse()
    expect(rows().map(r => r.source_file).sort()).toEqual([cursorDbPath, otherPath].sort())
  })
})
