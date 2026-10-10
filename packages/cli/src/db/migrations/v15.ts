import type Database from 'better-sqlite3'

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
 *   - `updated_at` is bumped so the corrected row is published again;
 *   - rows whose cost came from pricing are queued in `pending_cost_recalc`.
 *
 * Costs are not recomputed here: migrations run before the curated prices are
 * seeded and before the runtime price table (registry, aliases and legacy
 * `config.priceOverrides`) is loaded, so a price resolved at this point can
 * differ from the one the parser would use. `recalcPendingCosts` reprices the
 * queued rows once pricing is ready (see `initializeDatabase`). A logged cost
 * is never queued.
 *
 * Only `origin = 'local'` rows are touched. Rows pulled from other devices
 * belong to those devices' namespaces: each one corrects and re-publishes its
 * own rows when it runs this migration, and the corrected copy then replaces
 * the mirrored one here.
 */
export function migrateV15(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_cost_recalc (
      record_id TEXT PRIMARY KEY
    );
  `)

  const affected = `tool = 'codex' AND origin = 'local' AND cache_read_tokens > 0`

  db.prepare(`
    INSERT OR IGNORE INTO pending_cost_recalc (record_id)
    SELECT id FROM records WHERE ${affected} AND cost_source = 'pricing'
  `).run()

  db.prepare(`
    UPDATE records
    SET input_tokens = MAX(0, input_tokens - cache_read_tokens), updated_at = ?
    WHERE ${affected}
  `).run(Date.now())

  db.prepare('INSERT INTO schema_version (version) VALUES (15)').run()
}
