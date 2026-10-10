import Database from 'better-sqlite3'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyPragmas } from './schema.js'
import { runMigrations } from './migrations/index.js'
import { loadConfig } from '../config.js'
import { ensureCuratedPrices, ensureCuratedPricingAliases, loadPricingRuntime } from '../pricing-registry.js'
import { recalcPendingCosts } from './pending-cost-recalc.js'

export function initializeDatabase(db: Database.Database): void {
  applyPragmas(db)
  runMigrations(db)
  ensureCuratedPrices(db)
  ensureCuratedPricingAliases(db)
  const config = loadConfig()
  loadPricingRuntime(db, config)
  // Reprice records a migration re-counted, now that pricing is ready.
  recalcPendingCosts(db, config)
}

function removeCorruptedDb(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

export function createDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const db = new Database(path)
    initializeDatabase(db)
    return db
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
      console.warn(`Database corrupted, recreating: ${path}`)
      removeCorruptedDb(path)
      const db = new Database(path)
      initializeDatabase(db)
      return db
    }
    throw err
  }
}
