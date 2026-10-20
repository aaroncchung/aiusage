import type Database from 'better-sqlite3'
import { foldLineSeededRecordCopies } from '../records.js'

/**
 * Records stored twice: under the `'unknown'` sentinel's id and under the
 * device's own.
 *
 * Before v1.5.22 an installation without sync had no device id, so its rows
 * were stored under ids built from `'unknown'`, and they kept those ids when
 * they were relabelled with the device id v1.5.22 creates. Reading such a
 * source again under the device's id stored each record a second time:
 * v1.5.23's one-time Claude Code and CodeFuse re-imports did so for whole
 * histories, and so did a source read in full again for any other reason.
 *
 * Parsing now finds the original id (`recordIdForReread`), and every source
 * that is read again folds the copies it finds into their originals. This
 * migration removes the copies that are proven without reading the source,
 * which may be gone: those of records whose id is built from their source
 * file and line, where both ids can be rebuilt from the stored row (see
 * `foldLineSeededRecordCopies`). A copy is folded into its original rather
 * than the other way round, so the original keeps the id and the sync state
 * it has had longest; a sync target that received the copy has its wire id
 * retired.
 */
export function migrateV17(db: Database.Database): void {
  foldLineSeededRecordCopies(db)
  db.prepare('INSERT INTO schema_version (version) VALUES (17)').run()
}
