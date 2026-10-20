import type Database from 'better-sqlite3'
import { calculateCostForPrice, inferProvider, normalizeQoderModel, resolveExchangeRate } from '@aiusage/core'
import { loadConfig } from '../config.js'
import { applyPricingToSyncedRecords, type SyncedRecordPricing } from '../db/synced-records.js'
import { createRegistryPriceLookup } from '../pricing-registry.js'

export interface RecalcResult {
  updatedCount: number
  skippedCount: number
  /** Pulled rows whose `synced_records` mirror took the recalculated price. */
  syncedUpdatedCount: number
}

export interface RecalcProgress extends RecalcResult {
  /** Rows in `records` when the run started. */
  total: number
  /** Rows read so far, skipped ones included. */
  processed: number
}

export interface RecalcOptions {
  /**
   * This installation's device id (see `state.json`), when known. Every
   * reading that spans devices reads the current device's rows from `records`
   * and every other device's from `synced_records`, so that a copy of a local
   * row echoed through another namespace is never counted twice. The
   * recalculation writes the price it recomputed into that mirror, which
   * requires knowing which mirrors those readings exclude (see
   * `applyPricingToSyncedRecords`); without the id no mirror is excluded, as
   * every reading then reads `records` alone. Every row is repriced either
   * way.
   */
  currentDeviceInstanceId?: string
  /** Called before the first batch and after each batch. */
  onProgress?: (progress: RecalcProgress) => void
  /**
   * Awaited after each batch. The dashboard yields to the event loop here so
   * it keeps answering requests during a long run; a batch itself is one
   * transaction and is never interrupted.
   */
  betweenBatches?: () => Promise<void>
}

interface RecalcRow {
  id: string
  tool: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  thinking_tokens: number
  cost: number
  cost_source: string
}

const BATCH_SIZE = 1000

/**
 * The model a record is priced as. Qoder tier names are normalized, and a
 * Qoder record without a model is `qoder-auto`, as the Qoder parsers store it.
 */
function pricingModel(record: RecalcRow): string {
  if (record.tool !== 'qoder') return record.model
  const model = normalizeQoderModel(record.model)
  return model === 'unknown' ? 'qoder-auto' : model
}

/**
 * Reprice every record from the pricing registry. `aiusage recalc` and the
 * dashboard's *Recalculate now* (`POST /api/pricing/recalc`) both run this.
 * Each model is priced once per run, and the full price table is read at most
 * once (see `createRegistryPriceLookup`).
 */
export async function recalcPricing(db: Database.Database, options: RecalcOptions = {}): Promise<RecalcResult> {
  const { currentDeviceInstanceId, onProgress, betweenBatches } = options
  let updatedCount = 0
  let skippedCount = 0
  let syncedUpdatedCount = 0
  let processed = 0
  let lastId = ''
  const exchangeRate = resolveExchangeRate(loadConfig() ?? {})
  const prices = createRegistryPriceLookup(db)

  const selectBatch = db.prepare(
    'SELECT id, tool, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, cost_source FROM records WHERE id > @lastId ORDER BY id LIMIT @limit'
  )

  // A pulled row's updated_at is the version of the remote record it mirrors:
  // bumping it would make every later correction from its owner look stale to
  // mergeSyncedRecordsIntoRecords. Only locally parsed rows are marked changed.
  const updateStmt = db.prepare(`
    UPDATE records
    SET model = ?, provider = ?, cost = ?, cost_source = ?,
        updated_at = CASE WHEN origin = 'local' THEN ? ELSE updated_at END
    WHERE id = ?
  `)

  // The recalculated price is offered to the synced_records mirror of every row
  // repriced here (see applyPricingToSyncedRecords): the summaries read other
  // devices' usage from that table, so without it a recalculation left the
  // dashboard on the price the owner had published. A batch is read, repriced
  // and written to both tables in one transaction, so the two tables cannot be
  // left disagreeing, and no other writer changes a row between the read and
  // the write. Returns the number of rows read: 0 once every row was read.
  const mirrorOptions = currentDeviceInstanceId ? { excludeDeviceInstanceId: currentDeviceInstanceId } : {}
  const applyBatch = db.transaction((): number => {
    const batch = selectBatch.all({ lastId, limit: BATCH_SIZE }) as RecalcRow[]
    const repriced: SyncedRecordPricing[] = []

    for (const record of batch) {
      const model = pricingModel(record)

      // Logged costs are treated as authoritative and left untouched — EXCEPT when the
      // logged cost is non-positive (custom gateways report 0 for models they don't
      // price) or when the user has explicitly set a manual price for this model. In
      // both cases the logged value must not block pricing/recalc (issue #13).
      if (record.cost_source === 'log' && record.cost > 0 && !prices.hasUserPrice(model)) {
        skippedCount++
        continue
      }

      const provider = model !== record.model ? inferProvider(model) : record.provider
      const price = prices.price(model)
      const newCost = price ? calculateCostForPrice(price, {
        inputTokens: record.input_tokens,
        outputTokens: record.output_tokens,
        cacheReadTokens: record.cache_read_tokens,
        cacheWriteTokens: record.cache_write_tokens,
        thinkingTokens: record.thinking_tokens,
      }, exchangeRate) : 0
      const costSource = price ? 'pricing' : 'unknown'

      // Offered to the mirror even when the copy already carries the price: a
      // mirror pulled after an earlier run never took it, and nothing else
      // would write it there.
      repriced.push({ id: record.id, model, provider, cost: newCost, costSource })

      if (model !== record.model || provider !== record.provider || newCost !== record.cost || costSource !== record.cost_source) {
        updateStmt.run(model, provider, newCost, costSource, Date.now(), record.id)
        updatedCount++
      }
    }

    syncedUpdatedCount += applyPricingToSyncedRecords(db, repriced, mirrorOptions).length
    processed += batch.length
    if (batch.length > 0) lastId = batch[batch.length - 1].id
    return batch.length
  })

  const total = (db.prepare('SELECT COUNT(*) AS total FROM records').get() as { total: number }).total
  const progress = (): RecalcProgress => ({ total, processed, updatedCount, skippedCount, syncedUpdatedCount })

  onProgress?.(progress())
  while (applyBatch.immediate() > 0) {
    onProgress?.(progress())
    await betweenBatches?.()
  }

  return { updatedCount, skippedCount, syncedUpdatedCount }
}
