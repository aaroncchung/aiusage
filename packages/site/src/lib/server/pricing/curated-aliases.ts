import { CURATED_PRICE_ALIASES } from '@aiusage/core'
import type postgres from 'postgres'

// The client or a transaction.
type SqlClient = postgres.Sql | postgres.TransactionSql

/**
 * Seeds the curated aliases from `CURATED_PRICE_ALIASES` (e.g. gemini-3.1-pro →
 * gemini-3.1-pro-preview, issue #69) as builtin aliases. An alias is added only
 * when its target price exists, no price is registered under the alias name
 * itself (an alias would shadow it) and no alias of that name exists yet; an
 * alias seeded here is removed once a real price appears under its name and
 * follows the curated list when its target changes. Only rows with origin
 * 'builtin' and source 'aiusage' are touched (LiteLLM aliases carry source
 * 'litellm'). Runs after the schema migrations on every startup and at the end
 * of each LiteLLM pricing sync, so a deployment prices these models without
 * waiting for an admin sync.
 */
export async function ensureCuratedPricingAliases(client: SqlClient): Promise<{ added: number; updated: number }> {
  let added = 0, updated = 0
  for (const { alias, modelKey } of CURATED_PRICE_ALIASES) {
    await client`
      DELETE FROM model_price_aliases
      WHERE alias = ${alias} AND origin = 'builtin' AND source = 'aiusage'
        AND EXISTS (SELECT 1 FROM model_prices WHERE model_key = ${alias} AND status = 'active')
    `
    const retargeted = await client`
      UPDATE model_price_aliases
      SET model_key = ${modelKey},
          provider = (SELECT provider FROM model_prices WHERE model_key = ${modelKey}),
          updated_at = NOW()
      WHERE alias = ${alias} AND origin = 'builtin' AND source = 'aiusage' AND model_key <> ${modelKey}
        AND EXISTS (SELECT 1 FROM model_prices WHERE model_key = ${modelKey} AND status = 'active')
      RETURNING alias
    `
    if (retargeted.length > 0) updated++
    const inserted = await client`
      INSERT INTO model_price_aliases (alias, model_key, match_type, provider, priority, source, origin, enabled)
      SELECT ${alias}::text, model_key, 'exact', provider, 100, 'aiusage', 'builtin', TRUE
      FROM model_prices
      WHERE model_key = ${modelKey} AND status = 'active'
        AND NOT EXISTS (SELECT 1 FROM model_prices WHERE model_key = ${alias} AND status = 'active')
      ON CONFLICT (alias) DO NOTHING
      RETURNING alias
    `
    if (inserted.length > 0) added++
  }
  return { added, updated }
}
