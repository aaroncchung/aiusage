import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { recalcPricing } from '../../src/commands/recalc.js'
import {
  ensureCuratedPrices,
  listPricingModels,
  resetUserPriceToSynced,
  resolvePriceFromRegistry,
  setUserPrice,
} from '../../src/pricing-registry.js'

function insertLitellmPrice(db: Database.Database, modelKey: string, input: number, output: number, cacheRead: number, cacheWrite: number): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO model_prices (
      model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id,
      source_url, origin, status, last_synced_at, created_at, updated_at
    ) VALUES (?, 'anthropic', ?, ?, ?, ?, 'USD', 'litellm', ?, NULL, 'builtin', 'active', ?, ?, ?)
    ON CONFLICT(model_key) DO UPDATE SET
      input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
      cache_write = excluded.cache_write, source = 'litellm', origin = 'builtin'
  `).run(modelKey, input, output, cacheRead, cacheWrite, modelKey, now, now, now)
}

describe('curated prices', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('prices the curated models on a registry that has never been synced', () => {
    expect(resolvePriceFromRegistry(db, 'claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, currency: 'USD' })
    expect(resolvePriceFromRegistry(db, 'gpt-6-sol')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, currency: 'USD' })
    expect(resolvePriceFromRegistry(db, 'gpt-6-luna')).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, currency: 'USD' })
  })

  it('stops a stale registry from pricing Opus 5.5 as Opus 5 by prefix', () => {
    // A registry synced before Opus 5.5 launched: Opus 5 is there, Opus 5.5 is not.
    db.prepare("DELETE FROM model_prices WHERE model_key = 'claude-opus-5-5'").run()
    insertLitellmPrice(db, 'claude-opus-5', 5, 25, 0.5, 6.25)
    expect(resolvePriceFromRegistry(db, 'claude-opus-5-5')).toMatchObject({ input: 5, output: 25 })

    ensureCuratedPrices(db)

    expect(resolvePriceFromRegistry(db, 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(resolvePriceFromRegistry(db, 'claude-opus-5')).toMatchObject({ input: 5, output: 25 })
  })

  it('never overwrites a LiteLLM-synced price', () => {
    insertLitellmPrice(db, 'claude-opus-5-5', 4.5, 22.5, 0.45, 5.625)

    ensureCuratedPrices(db)

    const row = db.prepare("SELECT input, output, source FROM model_prices WHERE model_key = 'claude-opus-5-5'").get()
    expect(row).toEqual({ input: 4.5, output: 22.5, source: 'litellm' })
  })

  it('updates a price it seeded earlier when the curated rate changes', () => {
    db.prepare("UPDATE model_prices SET input = 5, output = 25 WHERE model_key = 'claude-opus-5-5'").run()
    db.prepare("UPDATE model_price_sync_baselines SET input = 5, output = 25 WHERE model_key = 'claude-opus-5-5'").run()

    ensureCuratedPrices(db)

    expect(resolvePriceFromRegistry(db, 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
    const baseline = db.prepare("SELECT input, output FROM model_price_sync_baselines WHERE model_key = 'claude-opus-5-5'").get()
    expect(baseline).toEqual({ input: 4, output: 20 })
  })

  it('keeps a user price, and resetting it returns to the curated price', () => {
    setUserPrice(db, 'gpt-6-sol', { input: 1, output: 1 })
    ensureCuratedPrices(db)
    expect(resolvePriceFromRegistry(db, 'gpt-6-sol')).toMatchObject({ input: 1, output: 1 })

    resetUserPriceToSynced(db, 'gpt-6-sol')

    expect(resolvePriceFromRegistry(db, 'gpt-6-sol')).toMatchObject({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })

  it('shows the curated price on the pricing page and recalculates records at it', async () => {
    insertRecord(db, {
      id: 'r1', ts: Date.now(), ingestedAt: Date.now(), updatedAt: Date.now(),
      lineOffset: 1, tool: 'claude-code', model: 'claude-opus-5-5', provider: 'anthropic',
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
      thinkingTokens: 0, cost: 36.75, costSource: 'pricing', sessionId: 's1',
      sourceFile: '/f1', device: 'd1', deviceInstanceId: 'di1',
    })

    const view = listPricingModels(db).find(model => model.model === 'claude-opus-5-5')
    expect(view).toMatchObject({ price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, source: 'aiusage', matchedBy: null })

    expect((await recalcPricing(db)).updatedCount).toBe(1)
    const record = db.prepare("SELECT cost FROM records WHERE id = 'r1'").get() as { cost: number }
    // 1M each of input, output, cache read and cache write: 4 + 20 + 0.2 + 5
    expect(record.cost).toBeCloseTo(29.2)
  })
})
