import Database from 'better-sqlite3'
import { mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPragmas } from './schema.js'
import { runMigrations } from './migrations/index.js'
import { loadConfig } from '../config.js'
import { ensureCuratedPrices, ensureCuratedPricingAliases, loadPricingRuntime } from '../pricing-registry.js'
import { recalcPendingCosts } from './pending-cost-recalc.js'
import { withSettingsLock } from '../settings-lock.js'

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

/** Open and initialize the database at `path`. A handle that fails to initialize is closed. */
function openDatabase(path: string): Database.Database {
  const db = new Database(path)
  try {
    initializeDatabase(db)
    return db
  } catch (err) {
    // On Windows an open handle keeps the file from being moved or deleted.
    try { db.close() } catch {}
    throw err
  }
}

function isCorrupted(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The files SQLite keeps beside a database. One left behind would be applied
 * to the new database created in its place.
 */
const SIDE_FILE_SUFFIXES = ['-wal', '-shm', '-journal']

/**
 * Move a corrupted database and the files SQLite keeps beside it out of the
 * way under one new name (`<path>.corrupt-<time>`, `<path>.corrupt-<time>-wal`,
 * ...), so they can still be opened together to recover what they hold: it
 * may be usage whose logs are gone. Returns the new path. Nothing is deleted
 * but the parsers' cursors.
 *
 * The cursors (`watermark.json` beside the database) say which logs the old
 * database already holds, so a new database behind them would never receive
 * that history. They are removed first: if the move then fails, the next run
 * finds the database still corrupted and starts again, and a database that
 * turns out to open after all only gets its records read again and updated
 * in place. The other way round, a failure would leave a new, empty database
 * behind the old cursors.
 *
 * The side files move before the database, and a move that fails undoes the
 * ones before it and throws: a database left in place keeps its own journal
 * and is found corrupted again on the next run.
 */
function moveCorruptedDbAside(path: string): string {
  const watermarkPath = join(dirname(path), 'watermark.json')
  try {
    unlinkSync(watermarkPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Database corrupted: ${path}. It was left in place because ${watermarkPath} could not be removed (${errorText(err)}).`)
    }
  }

  const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const moved: string[] = []
  try {
    for (const suffix of [...SIDE_FILE_SUFFIXES, '']) {
      try {
        renameSync(path + suffix, aside + suffix)
        moved.push(suffix)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
  } catch (err) {
    for (const suffix of moved.reverse()) {
      // A file that cannot be put back stays under the name the message gives.
      try { renameSync(aside + suffix, path + suffix) } catch {}
    }
    throw new Error(`Database corrupted: ${path}. It could not be moved to ${aside} (${errorText(err)}). Quit every aiusage process that may have it open (the dashboard, the widget) and run the command again.`)
  }
  return aside
}

/**
 * Open the database at `path`, creating it if there is none. A database
 * SQLite reports as corrupted is moved aside and replaced by a new one (see
 * `moveCorruptedDbAside`); the next parse imports the usage again from the
 * tools' logs. Every other error is thrown.
 */
export function createDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    return openDatabase(path)
  } catch (err) {
    if (!isCorrupted(err)) throw err
  }

  // Under the settings lock, and checked again once it is held: of two
  // processes that find the database corrupted at the same time, the second
  // opens the database the first one created instead of moving it aside too.
  return withSettingsLock(dirname(path), () => {
    try {
      return openDatabase(path)
    } catch (err) {
      if (!isCorrupted(err)) throw err
    }
    const aside = moveCorruptedDbAside(path)
    console.warn(`Database corrupted: moved ${path} to ${aside} and created a new one. The next parse imports the usage again from the tools' logs; usage whose logs no longer exist is only in the moved file.`)
    return openDatabase(path)
  })
}
