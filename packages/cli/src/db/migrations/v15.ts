import type Database from 'better-sqlite3'
import { calculateCostForPrice, resolveExchangeRate } from '@aiusage/core'
import { loadConfig } from '../../config.js'
import { resolvePriceFromRegistry } from '../../pricing-registry.js'

/**
 * Codex input tokens exclude cached tokens.
 *
 * Codex logs `input_tokens` inclusive of `cached_input_tokens`, and the parser
 * used to store both as-is. Every other tool stores `input_tokens` as the
 * uncached part only, and pricing charges input and cache-read separately, so
 * cached Codex tokens were counted in both columns and billed twice (once at
 * the input price, once at the cache-read price).
 *
 * The parser now subtracts the cached part. This migration applies the same
 * correction to the Codex rows this device parsed before the fix:
 *
 *   - `input_tokens` becomes `max(0, input_tokens - cache_read_tokens)`;
 *   - a cost that came from the price registry is recomputed from the
 *     corrected tokens (a logged cost, or a row with no resolvable price, is
 *     left alone);
 *   - `updated_at` is bumped so the corrected row is published again.
 *
 * Only `origin = 'local'` rows are touched. Rows pulled from other devices
 * belong to those devices' namespaces: each one corrects and re-publishes its
 * own rows when it runs this migration, and the newer copy then replaces the
 * mirrored one here.
 */
export function migrateV15(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           thinking_tokens, cost, cost_source
    FROM records
    WHERE tool = 'codex' AND origin = 'local' AND cache_read_tokens > 0
  `).all() as Array<{
    id: string
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    thinking_tokens: number
    cost: number
    cost_source: string
  }>

  if (rows.length > 0) {
    const exchangeRate = resolveExchangeRate(loadConfig() ?? {})
    const update = db.prepare('UPDATE records SET input_tokens = ?, cost = ?, updated_at = ? WHERE id = ?')
    const prices = new Map<string, ReturnType<typeof resolvePriceFromRegistry>>()
    const now = Date.now()

    for (const row of rows) {
      const inputTokens = Math.max(0, row.input_tokens - row.cache_read_tokens)
      let cost = row.cost
      if (row.cost_source === 'pricing') {
        if (!prices.has(row.model)) prices.set(row.model, resolvePriceFromRegistry(db, row.model))
        const price = prices.get(row.model)
        if (price) {
          cost = calculateCostForPrice(price, {
            inputTokens,
            outputTokens: row.output_tokens,
            cacheReadTokens: row.cache_read_tokens,
            cacheWriteTokens: row.cache_write_tokens,
            thinkingTokens: row.thinking_tokens,
          }, exchangeRate)
        }
      }
      update.run(inputTokens, cost, now, row.id)
    }
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (15)').run()
}
