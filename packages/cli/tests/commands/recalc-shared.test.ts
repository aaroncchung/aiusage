import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { recalcPricing, type RecalcProgress } from '../../src/commands/recalc.js'
import { createApiServer } from '../../src/api/server.js'

// `aiusage recalc` and the dashboard's *Recalculate now* run one function
// (issue #116). These tests cover what that function adds to the two loops it
// replaced: the per-run price lookup, the Qoder mapping the command lacked, and
// the progress and yield hooks the dashboard drives.

let dir: string
let db: Database.Database
let executed: string[] = []

function record(id: string, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id, ts: Date.now(), ingestedAt: Date.now(), updatedAt: 1,
    lineOffset: 0, tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
    inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionId: 's1',
    sourceFile: '/f1', device: 'd1', deviceInstanceId: 'di1',
    ...overrides,
  }
}

function insertPrice(modelKey: string, input: number, output: number, origin: 'builtin' | 'user' = 'builtin') {
  const now = Date.now()
  db.prepare(`
    INSERT OR REPLACE INTO model_prices (
      model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id,
      source_url, origin, status, last_synced_at, created_at, updated_at
    ) VALUES (?, '', ?, ?, NULL, NULL, 'USD', 'litellm', ?, NULL, ?, 'active', ?, ?, ?)
  `).run(modelKey, input, output, modelKey, origin, now, now, now)
}

function row(id: string) {
  return db.prepare('SELECT model, provider, cost, cost_source FROM records WHERE id = ?').get(id) as {
    model: string; provider: string; cost: number; cost_source: string
  }
}

const count = (pattern: RegExp) => executed.filter((sql) => pattern.test(sql)).length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiusage-recalc-'))
  db = new Database(join(dir, 'cache.db'), { verbose: (sql) => executed.push(String(sql)) })
  initializeDatabase(db)
  executed = []
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('recalcPricing', () => {
  it('looks each model up once and reads the full price table at most once (issue #116)', async () => {
    insertPrice('zz-model', 2, 4)
    // None of these has a direct user price or an exact alias: each needs the
    // full price table, which used to be read again for every record.
    const models = ['zz-model-20270101', 'zz-model-preview', 'zz-unpriced']
    for (const [m, model] of models.entries()) {
      for (let i = 0; i < 4; i++) insertRecord(db, record(`r-${m}-${i}`, { model, lineOffset: i }))
    }
    // Logged costs ask whether the model has a user price; that answer is cached too.
    for (let i = 0; i < 3; i++) {
      insertRecord(db, record(`log-${i}`, { model: 'zz-model-preview', cost: 0.5, costSource: 'log', lineOffset: 10 + i }))
    }
    executed = []

    const result = await recalcPricing(db)

    expect(result).toEqual({ updatedCount: 8, skippedCount: 3, syncedUpdatedCount: 0 })
    expect(count(/FROM model_prices WHERE status = 'active'/)).toBe(1)
    expect(count(/SELECT input, output, cache_read, cache_write, currency\s+FROM model_prices\s+WHERE model_key =/)).toBe(models.length)
    expect(count(/FROM model_price_aliases a/)).toBe(models.length)
    expect(row('r-0-0')).toEqual({ model: 'zz-model-20270101', provider: 'anthropic', cost: 4, cost_source: 'pricing' })
    expect(row('r-1-3')).toEqual({ model: 'zz-model-preview', provider: 'anthropic', cost: 4, cost_source: 'pricing' })
    expect(row('r-2-0')).toEqual({ model: 'zz-unpriced', provider: 'anthropic', cost: 0, cost_source: 'unknown' })
    expect(row('log-0')).toMatchObject({ cost: 0.5, cost_source: 'log' })
  })

  it('reads the registry again on the next run', async () => {
    insertPrice('zz-model', 2, 4)
    insertRecord(db, record('r1', { model: 'zz-model-20270101' }))
    await recalcPricing(db)
    expect(row('r1').cost).toBe(4)

    insertPrice('zz-model', 4, 8)
    insertPrice('zz-model-20270101', 1, 1, 'user')
    insertRecord(db, record('r2', { model: 'zz-model-preview', lineOffset: 1 }))
    const result = await recalcPricing(db)

    expect(result.updatedCount).toBe(2)
    expect(row('r1').cost).toBe(1.5)
    expect(row('r2').cost).toBe(8)
  })

  it('prices a Qoder record without a model as qoder-auto, as the Qoder parsers store it', async () => {
    insertPrice('qoder-auto', 2, 2)
    insertRecord(db, record('q-unknown', { tool: 'qoder', model: 'unknown', provider: 'unknown' }))
    insertRecord(db, record('q-empty', { tool: 'qoder', model: '', provider: 'unknown', lineOffset: 1 }))
    insertRecord(db, record('other-unknown', { tool: 'opencode', model: 'unknown', provider: 'unknown', lineOffset: 2 }))

    const result = await recalcPricing(db)

    expect(result.updatedCount).toBe(2)
    expect(row('q-unknown')).toEqual({ model: 'qoder-auto', provider: 'qoder', cost: 3, cost_source: 'pricing' })
    expect(row('q-empty')).toEqual({ model: 'qoder-auto', provider: 'qoder', cost: 3, cost_source: 'pricing' })
    expect(row('other-unknown')).toEqual({ model: 'unknown', provider: 'unknown', cost: 0, cost_source: 'unknown' })
  })

  it('reports progress before the first batch and after each one, and yields between batches outside a transaction', async () => {
    insertPrice('zz-model', 2, 4)
    db.transaction(() => {
      for (let i = 0; i < 2500; i++) insertRecord(db, record(`r${String(i).padStart(4, '0')}`, { model: 'zz-model', lineOffset: i }))
    })()

    const progress: RecalcProgress[] = []
    const yields: Array<{ inTransaction: boolean; priced: number }> = []
    const result = await recalcPricing(db, {
      onProgress: (p) => progress.push(p),
      betweenBatches: async () => {
        const priced = (db.prepare("SELECT COUNT(*) AS n FROM records WHERE cost_source = 'pricing'").get() as { n: number }).n
        yields.push({ inTransaction: db.inTransaction, priced })
      },
    })

    expect(result).toEqual({ updatedCount: 2500, skippedCount: 0, syncedUpdatedCount: 0 })
    expect(progress.map((p) => [p.total, p.processed, p.updatedCount])).toEqual([
      [2500, 0, 0],
      [2500, 1000, 1000],
      [2500, 2000, 2000],
      [2500, 2500, 2500],
    ])
    expect(yields).toEqual([
      { inTransaction: false, priced: 1000 },
      { inTransaction: false, priced: 2000 },
      { inTransaction: false, priced: 2500 },
    ])
  })
})

describe('POST /api/pricing/recalc', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    server = createApiServer(db, { currentDeviceInstanceId: 'di1' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function waitForDone() {
    for (let i = 0; i < 100; i++) {
      const status = await (await fetch(`${baseUrl}/api/pricing/recalc`)).json()
      if (status.state === 'done') return status
      if (status.state === 'error') throw new Error(status.error)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('pricing recalc did not finish')
  }

  it('runs the same recalculation and reports its counts in the status it always had', async () => {
    insertPrice('zz-model', 2, 4)
    insertPrice('qoder-auto', 2, 2)
    insertRecord(db, record('priced', { model: 'zz-model-20270101' }))
    insertRecord(db, record('qoder', { tool: 'qoder', model: 'unknown', provider: 'unknown', lineOffset: 1 }))
    insertRecord(db, record('logged', { model: 'zz-model', cost: 0.5, costSource: 'log', lineOffset: 2 }))
    insertRecord(db, record('current', { model: 'zz-model', cost: 4, costSource: 'pricing', lineOffset: 3 }))
    executed = []

    const start = await fetch(`${baseUrl}/api/pricing/recalc`, { method: 'POST' })
    expect(start.status).toBe(202)
    const done = await waitForDone()

    expect(Object.keys(done).sort()).toEqual([
      'error', 'finishedAt', 'needsRecalc', 'needsRecalcSince', 'processed', 'queuePending',
      'queueRunning', 'skipped', 'startedAt', 'state', 'total', 'updated',
    ])
    expect(done).toMatchObject({ total: 4, processed: 4, updated: 2, skipped: 1 })
    expect(count(/FROM model_prices WHERE status = 'active'/)).toBe(1)
    expect(row('priced')).toMatchObject({ cost: 4, cost_source: 'pricing' })
    expect(row('qoder')).toEqual({ model: 'qoder-auto', provider: 'qoder', cost: 3, cost_source: 'pricing' })
    expect(row('logged')).toMatchObject({ cost: 0.5, cost_source: 'log' })
  })
})
