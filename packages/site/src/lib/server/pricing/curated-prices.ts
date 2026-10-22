import { CURATED_PRICES } from '@aiusage/core'
import type postgres from 'postgres'

// The client or a transaction.
type SqlClient = postgres.Sql | postgres.TransactionSql

/**
 * Seeds `CURATED_PRICES` (e.g. claude-opus-5-5, which prefix matching priced as
 * claude-opus-5 until a sync listed it) as builtin prices with source 'aiusage'.
 * A price is written only when no row exists for its key, or when the existing
 * row is one seeded here and the curated rate has changed; LiteLLM-synced and
 * admin-entered prices are never touched. Runs after the schema migrations on
 * every startup, so a deployment prices these models without an admin sync.
 */
export async function ensureCuratedPrices(client: SqlClient): Promise<number> {
  let written = 0
  for (const { modelKey, provider, price, sourceUrl } of CURATED_PRICES) {
    const cacheRead = price.cacheRead ?? null
    const cacheWrite = price.cacheWrite ?? null
    const currency = price.currency ?? 'USD'
    const rows = await client`
      INSERT INTO model_prices (model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id, source_url, origin, status)
      VALUES (${modelKey}, ${provider}, ${price.input}, ${price.output}, ${cacheRead}, ${cacheWrite}, ${currency}, 'aiusage', ${modelKey}, ${sourceUrl}, 'builtin', 'active')
      ON CONFLICT (model_key) DO UPDATE SET
        provider = EXCLUDED.provider,
        input = EXCLUDED.input,
        output = EXCLUDED.output,
        cache_read = EXCLUDED.cache_read,
        cache_write = EXCLUDED.cache_write,
        currency = EXCLUDED.currency,
        source_url = EXCLUDED.source_url,
        status = 'active',
        updated_at = NOW()
      WHERE model_prices.origin = 'builtin' AND model_prices.source = 'aiusage'
        AND (model_prices.input IS DISTINCT FROM EXCLUDED.input OR model_prices.output IS DISTINCT FROM EXCLUDED.output
          OR model_prices.cache_read IS DISTINCT FROM EXCLUDED.cache_read OR model_prices.cache_write IS DISTINCT FROM EXCLUDED.cache_write
          OR model_prices.currency IS DISTINCT FROM EXCLUDED.currency OR model_prices.status <> 'active')
      RETURNING model_key
    `
    written += rows.length
  }
  return written
}
