import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, getUnsyncedRecords } from '../../src/db/records.js'
import { migrateV15 } from '../../src/db/migrations/v15.js'
import { setUserPrice } from '../../src/pricing-registry.js'
import type { StatsRecord } from '@aiusage/core'

// Codex logs input_tokens inclusive of cached_input_tokens. Rows parsed before
// the parser subtracted the cached part carry it in both columns and were
// priced twice; v15 corrects the rows this device parsed.

const MODEL = 'v15-test-model'

function makeRecord(overrides: Partial<StatsRecord>): StatsRecord {
  return {
    id: 'rec',
    ts: 1000,
    ingestedAt: 1000,
    syncedAt: 5000,
    updatedAt: 1000,
    lineOffset: 0,
    tool: 'codex',
    model: MODEL,
    provider: 'openai',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    // 1M input * $2 + 0.1M output * $10 + 0.9M cached * $0.2 (cached part billed twice)
    cost: 2 + 1 + 0.18,
    costSource: 'pricing',
    sessionId: 'sess',
    sourceFile: '/Users/a/.codex/sessions/2026/06/01/rollout-x.jsonl',
    device: 'host-a',
    deviceInstanceId: 'device-a',
    ...overrides,
  }
}

function row(db: Database.Database, id: string) {
  return db.prepare('SELECT input_tokens, cache_read_tokens, cost, updated_at FROM records WHERE id = ?').get(id) as {
    input_tokens: number; cache_read_tokens: number; cost: number; updated_at: number
  }
}

describe('migration v15 (Codex input tokens exclude cached tokens)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    setUserPrice(db, MODEL, { input: 2, output: 10, cacheRead: 0.2 })
    // initializeDatabase already ran v15 on the empty DB. Roll back just the
    // version row so we can seed records and re-run migrateV15 deterministically.
    db.prepare('DELETE FROM schema_version WHERE version = 15').run()
  })

  afterEach(() => db.close())

  it('subtracts cached tokens from input and reprices the row', () => {
    insertRecord(db, makeRecord({ id: 'codex-cached' }))

    migrateV15(db)

    const r = row(db, 'codex-cached')
    expect(r.input_tokens).toBe(100_000)
    expect(r.cache_read_tokens).toBe(900_000)
    // 0.1M input * $2 + 0.1M output * $10 + 0.9M cached * $0.2
    expect(r.cost).toBeCloseTo(0.2 + 1 + 0.18, 10)
  })

  it('bumps updated_at so the corrected row is published again', () => {
    insertRecord(db, makeRecord({ id: 'codex-cached' }))
    expect(getUnsyncedRecords(db).map(r => r.id)).not.toContain('codex-cached')

    migrateV15(db)

    expect(getUnsyncedRecords(db).map(r => r.id)).toContain('codex-cached')
  })

  it('leaves rows without cached tokens untouched', () => {
    insertRecord(db, makeRecord({ id: 'codex-uncached', cacheReadTokens: 0, cost: 3 }))

    migrateV15(db)

    const r = row(db, 'codex-uncached')
    expect(r.input_tokens).toBe(1_000_000)
    expect(r.cost).toBe(3)
    expect(r.updated_at).toBe(1000)
  })

  it('leaves other tools and rows pulled from other devices untouched', () => {
    insertRecord(db, makeRecord({ id: 'claude', tool: 'claude-code' }))
    insertRecord(db, makeRecord({ id: 'pulled', origin: 'synced', deviceInstanceId: 'device-b' }))

    migrateV15(db)

    for (const id of ['claude', 'pulled']) {
      const r = row(db, id)
      expect(r.input_tokens).toBe(1_000_000)
      expect(r.cost).toBeCloseTo(3.18, 10)
      expect(r.updated_at).toBe(1000)
    }
  })

  it('keeps a logged cost and a cost with no resolvable price', () => {
    insertRecord(db, makeRecord({ id: 'logged', cost: 1.5, costSource: 'log' }))
    insertRecord(db, makeRecord({ id: 'unpriced', model: 'v15-no-such-model', cost: 0, costSource: 'unknown' }))

    migrateV15(db)

    expect(row(db, 'logged')).toMatchObject({ input_tokens: 100_000, cost: 1.5 })
    expect(row(db, 'unpriced')).toMatchObject({ input_tokens: 100_000, cost: 0 })
  })

  it('never produces negative input tokens', () => {
    insertRecord(db, makeRecord({ id: 'odd', inputTokens: 10, cacheReadTokens: 50 }))

    migrateV15(db)

    expect(row(db, 'odd').input_tokens).toBe(0)
  })

  it('records schema version 15', () => {
    migrateV15(db)

    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }
    expect(version.version).toBe(15)
  })
})
