import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { generateRecordId } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'

// tests/setup-home.ts gives this file its own home directory.
const aiusageDir = join(homedir(), '.aiusage')
const DEVICE = 'device-codebuddy-test'

interface Row {
  id: string
  ts: number
  input_tokens: number
  output_tokens: number
  source_file: string
}

describe('runParse with a CodeBuddy IDE conversation that gets more turns', () => {
  let dataDir: string
  let db: Database.Database
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    // Overrides inherited from the environment would win over the fixture or add other CodeBuddy sources.
    for (const key of ['AIUSAGE_CODEBUDDY_IDE_PATH', 'AIUSAGE_CODEBUDDY_PATH', 'CODEBUDDY_HOME']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value
    }
  })

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'aiu-codebuddy-'))
    rmSync(aiusageDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'codebuddy-ide': dataDir } }))
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const conversationDir = (conversation: string) =>
    join(dataDir, 'default', 'CodeBuddyIDE', 'ws', 'history', 'session-1', conversation)

  /** Write the final assistant message of one turn, carrying the conversation's running snapshot. */
  function turn(conversation: string, n: number, createdAt: string, cacheMissTokens: number, lastOutputTokens: number): void {
    const messagesDir = join(conversationDir(conversation), 'messages')
    mkdirSync(messagesDir, { recursive: true })
    writeFileSync(join(messagesDir, `turn-${n}.json`), JSON.stringify({
      role: 'assistant',
      message: '{}',
      id: `a-${n}`,
      createdAt,
      extra: JSON.stringify({
        modelId: 'deepseek-v4-flash',
        statsSnapshot: { cachedInputTokens: 0, cacheMissTokens, cacheWriteTokens: 0, thinkingTokens: 0, lastOutputTokens },
      }),
    }))
  }

  const rows = () => db.prepare(
    `SELECT id, ts, input_tokens, output_tokens, source_file FROM records WHERE tool = 'codebuddy' ORDER BY source_file`,
  ).all() as Row[]

  it('replaces the conversation record when a turn is added (issue #81)', async () => {
    turn('conv-1', 1, '2026-07-01T06:00:00.000Z', 1000, 50)
    await runParse(db, 'codebuddy')
    expect(rows().map(r => r.input_tokens)).toEqual([1000])

    turn('conv-1', 2, '2026-07-01T07:00:00.000Z', 2500, 80)
    const result = await runParse(db, 'codebuddy')
    expect(result.errors).toEqual([])

    const stored = rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      id: generateRecordId(DEVICE, conversationDir('conv-1'), 0),
      ts: Date.parse('2026-07-01T07:00:00.000Z'),
      input_tokens: 2500,
      output_tokens: 80,
    })
  })

  it('keeps one record for each conversation', async () => {
    turn('conv-1', 1, '2026-07-01T06:00:00.000Z', 1000, 50)
    turn('conv-2', 1, '2026-07-01T06:30:00.000Z', 400, 20)
    await runParse(db, 'codebuddy')
    turn('conv-1', 2, '2026-07-01T07:00:00.000Z', 2500, 80)
    await runParse(db, 'codebuddy')

    expect(rows().map(r => [r.source_file, r.input_tokens])).toEqual([
      [conversationDir('conv-1'), 2500],
      [conversationDir('conv-2'), 400],
    ])
  })
})
