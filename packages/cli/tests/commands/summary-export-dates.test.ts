// `aiusage summary` and `aiusage export` filter by their date options (#99)
// instead of ignoring them. Runs the real commands against a database in the
// test home (tests/setup-home.ts), with the time zone and the clock pinned:
// Tuesday 2026-10-20, 09:00 in New York.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AIUSAGE_DIR, CONFIG_PATH } from '../../src/config.js'
import { createDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { exportData } from '../../src/commands/export.js'

const originalTz = process.env.TZ
process.env.TZ = 'America/New_York'

const local = (y: number, m: number, d: number, h = 12, mi = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, mi, s, ms).getTime()

// Input tokens are powers of ten, so a total shows which rows were counted.
const ROWS: Array<[string, number, number]> = [
  ['sep25', local(2026, 9, 25), 1],
  ['oct14', local(2026, 10, 14), 10],
  ['oct15-first-ms', local(2026, 10, 15, 0, 0, 0, 0), 100],
  ['oct15-last-ms', local(2026, 10, 15, 23, 59, 59, 999), 1000],
  ['oct16-first-ms', local(2026, 10, 16, 0, 0, 0, 0), 10000],
  ['oct18-sunday', local(2026, 10, 18), 100000],
  ['oct19-monday', local(2026, 10, 19), 1000000],
  ['oct20-today', local(2026, 10, 20, 0, 30), 10000000],
]

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`) }
}

/** Run the CLI once, from a fresh module: commander keeps option values between parses. */
async function run(...args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = []
  const err: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')) })
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitCalled(code) }) as never)
  let exitCode = 0
  try {
    vi.resetModules()
    const { runCli } = await import('../../src/cli.js')
    await runCli(['node', 'aiusage', ...args])
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e
    exitCode = e.code ?? 0
  } finally {
    log.mockRestore()
    error.mockRestore()
    exit.mockRestore()
  }
  return { out: out.join('\n'), err: err.join('\n'), exitCode }
}

function totalTokens(out: string): number {
  const m = /Total Tokens: ([\d,]+)/.exec(out)
  if (!m) throw new Error(`no total in:\n${out}`)
  return Number(m[1].replace(/,/g, ''))
}

function csvSessions(out: string): string[] {
  return out.split('\n').slice(1).filter(Boolean).map(line => line.split(',')[11].replace(/^s-/, ''))
}

describe('summary and export date options (#99)', () => {
  beforeAll(() => {
    const db = createDatabase(join(AIUSAGE_DIR, 'cache.db'))
    for (const [id, ts, tokens] of ROWS) {
      insertRecord(db, {
        id: `r-${id}`, ts, ingestedAt: ts, updatedAt: ts, lineOffset: 0,
        tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
        inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        thinkingTokens: 0, cost: tokens / 1e6, costSource: 'pricing', sessionId: `s-${id}`,
        sourceFile: '/fixture.jsonl', device: 'fixture-host', deviceInstanceId: 'fixture-device',
      })
    }
    db.close()
  })

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 9, 20, 9), toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(CONFIG_PATH, { force: true })
  })

  it('summary without date options still counts everything', async () => {
    const plain = await run()
    const summary = await run('summary')
    expect(totalTokens(plain.out)).toBe(11_111_111)
    expect(summary.out).toBe(plain.out)
    expect(summary.out).toContain('Records:      8')
  })

  it('summary --week and --month start where the dashboard presets start', async () => {
    expect(totalTokens((await run('summary', '--week')).out)).toBe(11_000_000)
    expect(totalTokens((await run('summary', '--month')).out)).toBe(11_111_110)
    // The dashboard's "week starts on Sunday" setting applies here too.
    writeFileSync(CONFIG_PATH, JSON.stringify({ weekStart: 0 }))
    expect(totalTokens((await run('summary', '--week')).out)).toBe(11_100_000)
  })

  it('summary --from / --to count whole local days, both included', async () => {
    const day = await run('summary', '--from', '2026-10-15', '--to', '2026-10-15')
    expect(totalTokens(day.out)).toBe(1_100)
    expect(day.out).toContain('Records:      2')
    expect(totalTokens((await run('summary', '--from', '2026-10-15')).out)).toBe(11_111_100)
    expect(totalTokens((await run('summary', '--to', '2026-10-15')).out)).toBe(1_111)
  })

  it('summary combines the date options with --tool', async () => {
    expect(totalTokens((await run('summary', '--month', '--tool', 'claude-code')).out)).toBe(11_111_110)
    expect(totalTokens((await run('summary', '--month', '--tool', 'codex')).out)).toBe(0)
  })

  it('export without date options is unchanged', async () => {
    const db = createDatabase(join(AIUSAGE_DIR, 'cache.db'))
    for (const format of ['csv', 'json', 'ndjson'] as const) {
      const result = await run('export', '--format', format)
      expect(result.exitCode).toBe(0)
      expect(result.out).toBe(exportData(db, format))
    }
    db.close()
    expect(csvSessions((await run('export', '--format', 'csv')).out)).toEqual(ROWS.map(([id]) => id))
  })

  it('export --from / --to keep whole local days, in table order', async () => {
    const day = await run('export', '--format', 'csv', '--from', '2026-10-15', '--to', '2026-10-15')
    expect(csvSessions(day.out)).toEqual(['oct15-first-ms', 'oct15-last-ms'])
    const days = await run('export', '--format', 'csv', '--from', '2026-10-14', '--to', '2026-10-16')
    expect(csvSessions(days.out)).toEqual(['oct14', 'oct15-first-ms', 'oct15-last-ms', 'oct16-first-ms'])
    expect(csvSessions((await run('export', '--format', 'csv', '--from', '2026-10-19')).out)).toEqual(['oct19-monday', 'oct20-today'])
    expect(csvSessions((await run('export', '--format', 'csv', '--to', '2026-09-30')).out)).toEqual(['sep25'])
  })

  it('export --range day / week / month', async () => {
    const day = await run('export', '--format', 'ndjson', '--range', 'day')
    expect(day.out.split('\n').map(line => JSON.parse(line).id)).toEqual(['r-oct20-today'])
    expect(csvSessions((await run('export', '--format', 'csv', '--range', 'week')).out)).toEqual(['oct19-monday', 'oct20-today'])
    const month = JSON.parse((await run('export', '--format', 'json', '--range', 'month')).out)
    expect(month).toHaveLength(7)
  })

  it.each([
    [['summary', '--from', '2026-02-30'], 'Invalid --from date: 2026-02-30. Use YYYY-MM-DD.'],
    [['summary', '--to', '10/15/2026'], 'Invalid --to date: 10/15/2026. Use YYYY-MM-DD.'],
    [['summary', '--from', '2026-10-16', '--to', '2026-10-15'], '--from 2026-10-16 is after --to 2026-10-15.'],
    [['summary', '--week', '--month'], 'Cannot use --week and --month together. Use one or the other.'],
    [['summary', '--week', '--to', '2026-10-15'], 'Cannot use --week with --from or --to.'],
    [['summary', '--month', '--from', '2026-10-15'], 'Cannot use --month with --from or --to.'],
    [['export', '--format', 'csv', '--range', 'year'], 'Invalid range. Use day, week, or month.'],
    [['export', '--format', 'csv', '--range', 'week', '--from', '2026-10-15'], 'Cannot use --range with --from or --to.'],
    [['export', '--format', 'csv', '--from', '2026-1-5'], 'Invalid --from date: 2026-1-5. Use YYYY-MM-DD.'],
  ])('%j fails with a message', async (args, message) => {
    const result = await run(...args)
    expect(result.exitCode).toBe(1)
    expect(result.err).toBe(message)
    expect(result.out).toBe('')
  })
})
