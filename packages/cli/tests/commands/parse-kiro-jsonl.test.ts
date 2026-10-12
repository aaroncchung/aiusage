import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { kiroLogLineId } from '../../src/commands/importer-duplicates.js'
import { initializeDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'

// tests/setup-home.ts gives this file its own home directory.
const aiusageDir = join(homedir(), '.aiusage')
const DEVICE = 'device-kiro-test'

interface Row {
  id: string
  ts: number
  line_offset: number
  input_tokens: number
  output_tokens: number
}

describe('runParse with a Kiro token log (tokens_generated.jsonl)', () => {
  let root: string
  let logPath: string
  let db: Database.Database
  let clock: number
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    // Keep the default Kiro locations inside the test home on every platform.
    for (const key of ['APPDATA', 'XDG_DATA_HOME', 'KIRO_HOME', 'AIUSAGE_KIRO_PATH']) savedEnv[key] = process.env[key]
    // An override inherited from the environment would win over the fixture.
    process.env.APPDATA = join(homedir(), 'AppData', 'Roaming')
    process.env.XDG_DATA_HOME = join(homedir(), '.local', 'share')
    delete process.env.KIRO_HOME
    delete process.env.AIUSAGE_KIRO_PATH
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiu-kiro-jsonl-'))
    logPath = join(root, 'tokens_generated.jsonl')
    rmSync(aiusageDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { kiro: root } }))
    db = new Database(':memory:')
    initializeDatabase(db)
    clock = 1_780_000_000
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** Write `text` to the log (appending unless `replace`) and move its mtime forward. */
  function write(text: string, replace = false): number {
    if (replace) writeFileSync(logPath, text)
    else appendFileSync(logPath, text)
    clock += 60
    utimesSync(logPath, clock, clock)
    return clock * 1000
  }

  const request = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ model: 'claude-sonnet-4', provider: 'kiro', promptTokens: 100, generatedTokens: 10, ...extra }) + '\n'

  const rows = () => db.prepare(
    `SELECT id, ts, line_offset, input_tokens, output_tokens FROM records WHERE tool = 'kiro' ORDER BY line_offset, ts`,
  ).all() as Row[]

  const totals = () => db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM records WHERE tool = 'kiro'`,
  ).get() as { n: number; input: number; output: number }

  it('stores each request once however often the log grows (issue #79)', async () => {
    write(request() + request())
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 2, input: 200, output: 20 })

    write(request())
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 3, input: 300, output: 30 })

    write(request())
    const result = await runParse(db, 'kiro')
    expect(result.errors).toEqual([])
    // Only the appended line is read on the third parse.
    expect(result.parsedCount).toBe(1)
    expect(totals()).toEqual({ n: 4, input: 400, output: 40 })
  })

  it('builds the id from the file path, the byte offset and the line, not from a time', async () => {
    const first = request()
    write(first + request())
    await runParse(db, 'kiro')
    write(request())
    await runParse(db, 'kiro')

    const lineLength = Buffer.byteLength(first, 'utf-8')
    expect(rows().map(r => ({ id: r.id, line_offset: r.line_offset }))).toEqual([0, 1, 2].map(i => ({
      id: kiroLogLineId(DEVICE, logPath, i * lineLength, first.trimEnd()),
      line_offset: i * lineLength,
    })))
  })

  it('uses the timestamp of the line when it has one and the file time otherwise', async () => {
    const stamped = request({ timestamp: '2026-05-01T10:00:00.000Z' })
    const mtime = write(stamped + request())
    await runParse(db, 'kiro')

    const [first, second] = rows()
    expect(first.ts).toBe(Date.parse('2026-05-01T10:00:00.000Z'))
    expect(second.ts).toBe(mtime)

    // A later append does not move the records that were already stored.
    const laterMtime = write(request())
    await runParse(db, 'kiro')
    const after = rows()
    expect(after.map(r => r.ts)).toEqual([first.ts, mtime, laterMtime])
  })

  it('does not parse an unchanged log again', async () => {
    write(request() + request())
    await runParse(db, 'kiro')
    const result = await runParse(db, 'kiro')
    expect(result.parsedCount).toBe(0)
    expect(totals().n).toBe(2)
  })

  it('reads a line that was still being written once it is complete', async () => {
    const line = request()
    const half = Math.floor(line.length / 2)
    write(request() + line.slice(0, half))
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 1, input: 100, output: 10 })

    write(line.slice(half))
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 2, input: 200, output: 20 })

    write(request())
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 3, input: 300, output: 30 })
  })

  it('reads a complete last line that has no trailing newline, once', async () => {
    write(request() + request().trimEnd())
    await runParse(db, 'kiro')
    expect(totals().n).toBe(2)

    write('\n' + request())
    await runParse(db, 'kiro')
    expect(totals()).toEqual({ n: 3, input: 300, output: 30 })
  })

  it('reads a log from the start again when it was replaced by one with the same line lengths', async () => {
    write(request() + request())
    await runParse(db, 'kiro')

    const other = () => request({ promptTokens: 200 })
    write(other() + other() + other(), true)
    const result = await runParse(db, 'kiro')
    expect(result.parsedCount).toBe(3)
    // The requests of the first log are history and stay beside the new ones.
    expect(rows().map(r => r.input_tokens)).toEqual([100, 200, 100, 200, 200])
    expect(totals()).toEqual({ n: 5, input: 800, output: 50 })

    const again = await runParse(db, 'kiro')
    expect(again.parsedCount).toBe(0)
  })

  it('reads a log from the start again when it was replaced by one of the same size or shorter', async () => {
    write(request() + request())
    await runParse(db, 'kiro')

    write(request({ promptTokens: 300 }) + request({ promptTokens: 300 }), true)
    await runParse(db, 'kiro')
    expect(rows().map(r => r.input_tokens)).toEqual([100, 300, 100, 300])

    write(request({ promptTokens: 500 }), true)
    await runParse(db, 'kiro')
    expect(rows().map(r => r.input_tokens)).toEqual([100, 300, 500, 100, 300])

    // Each of the three logs is read once.
    const again = await runParse(db, 'kiro')
    expect(again.parsedCount).toBe(0)
    expect(totals().n).toBe(5)
  })

  it('does not read a log again whose time changed but whose content did not', async () => {
    write(request() + request())
    await runParse(db, 'kiro')
    const before = rows()
    write('')
    const result = await runParse(db, 'kiro')
    expect(result.parsedCount).toBe(0)
    expect(rows()).toEqual(before)
  })

  it('reads a log from the start again when it was replaced by a longer one', async () => {
    write(request() + request())
    await runParse(db, 'kiro')

    // A different, longer file: the stored offset now falls inside a line.
    const other = (n: number) => JSON.stringify({ model: 'claude-sonnet-4', provider: 'kiro', promptTokens: n, generatedTokens: 1, pad: 'xxxxxxx' }) + '\n'
    write(other(7) + other(8) + other(9), true)
    const result = await runParse(db, 'kiro')
    expect(result.parsedCount).toBe(3)
    expect(rows().map(r => r.input_tokens).sort((a, b) => a - b)).toEqual([7, 8, 9, 100, 100])
  })
})
