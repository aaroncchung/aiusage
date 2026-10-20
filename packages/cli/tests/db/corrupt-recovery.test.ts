import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Failures injected into the renames and deletions src/db/index.ts makes.
const fsHooks = vi.hoisted(() => ({
  failRename: null as null | ((from: string) => boolean),
  failUnlink: null as null | ((path: string) => boolean),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const fail = (code: string, op: string, path: string) =>
    Object.assign(new Error(`${code}: injected failure, ${op} '${path}'`), { code })
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (fsHooks.failRename?.(String(from))) throw fail('EBUSY', 'rename', String(from))
      return actual.renameSync(from, to)
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (fsHooks.failUnlink?.(String(path))) throw fail('EPERM', 'unlink', String(path))
      return actual.unlinkSync(path)
    },
  }
})

import { createDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'

const NOT_A_DATABASE = 'this is not a SQLite database\n'

describe('createDatabase with a corrupted database (#93)', () => {
  let dir: string
  let dbPath: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-corrupt-'))
    dbPath = join(dir, 'cache.db')
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    fsHooks.failRename = null
    fsHooks.failUnlink = null
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  /** Files in the directory, the settings lock aside. */
  function files(): string[] {
    return readdirSync(dir).filter(name => name !== 'settings.lock').sort()
  }

  function asideFiles(): string[] {
    return files().filter(name => name.startsWith('cache.db.corrupt-'))
  }

  /** A healthy database, closed (so it has no journal files), returned as bytes. */
  function healthyDatabase(): Buffer {
    const db = createDatabase(dbPath)
    db.close()
    return readFileSync(dbPath)
  }

  /**
   * Journal files as a process killed in the middle of its work leaves them:
   * a WAL holding a write to an existing database that was never
   * checkpointed, and its index. They are copied from a connection that is
   * still open, then put beside `dbPath`. Without the pages already in the
   * database file, SQLite finds the result corrupted.
   */
  function leaveJournalFiles(): void {
    const source = mkdtempSync(join(tmpdir(), 'aiusage-corrupt-src-'))
    const sourcePath = join(source, 'cache.db')
    createDatabase(sourcePath).close()
    const writer = new Database(sourcePath)
    try {
      writer.pragma('wal_autocheckpoint = 0')
      writer.exec('CREATE TABLE only_in_the_wal (v TEXT)')
      writer.prepare('INSERT INTO only_in_the_wal (v) VALUES (?)').run('written before the crash')
      copyFileSync(sourcePath + '-wal', dbPath + '-wal')
      copyFileSync(sourcePath + '-shm', dbPath + '-shm')
    } finally {
      writer.close()
      rmSync(source, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }

  function expectUsable(db: Database.Database): void {
    expect((db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n).toBe(0)
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    expect(version.v).toBeGreaterThanOrEqual(16)
  }

  it('moves a file that is not a database aside, keeps it byte for byte, and creates a new one', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)

    const db = createDatabase(dbPath)
    try {
      expectUsable(db)
    } finally {
      db.close()
    }

    const aside = asideFiles()
    expect(aside).toHaveLength(1)
    expect(aside[0]).toMatch(/^cache\.db\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    expect(readFileSync(join(dir, aside[0]), 'utf-8')).toBe(NOT_A_DATABASE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain(join(dir, aside[0]))
  })

  it('moves the WAL and its index with the database, under the same name, and does not apply them to the new one', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)
    leaveJournalFiles()
    const wal = readFileSync(dbPath + '-wal')
    expect(wal.length).toBeGreaterThan(0)

    const db = createDatabase(dbPath)
    try {
      expectUsable(db)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'only_in_the_wal'").get()).toBeUndefined()
    } finally {
      db.close()
    }

    const [main, ...rest] = asideFiles()
    expect(rest).toEqual([`${main}-shm`, `${main}-wal`])
    expect(readFileSync(join(dir, main), 'utf-8')).toBe(NOT_A_DATABASE)
    expect(readFileSync(join(dir, `${main}-wal`)).equals(wal)).toBe(true)
  })

  it('recovers from a damaged page (SQLITE_CORRUPT)', () => {
    healthyDatabase()
    // The b-tree header of page 1 (sqlite_schema) follows the 100-byte file header.
    const fd = openSync(dbPath, 'r+')
    writeSync(fd, Buffer.alloc(32, 0xff), 0, 32, 100)
    closeSync(fd)
    const damaged = readFileSync(dbPath)

    const db = createDatabase(dbPath)
    try {
      expectUsable(db)
    } finally {
      db.close()
    }

    const [main] = asideFiles()
    expect(readFileSync(join(dir, main)).equals(damaged)).toBe(true)
  })

  it('resets the import cursors beside the database and leaves the other settings alone', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)
    writeFileSync(join(dir, 'watermark.json'), JSON.stringify({ files: { 'claude-code': { '/logs/a.jsonl': { offset: 10, size: 10, mtime: 1 } } } }))
    const state = JSON.stringify({ deviceInstanceId: 'device-1', lastSyncStatus: 'ok', syncTargets: { cloud: { syncGeneration: 3 } } })
    writeFileSync(join(dir, 'state.json'), state)
    writeFileSync(join(dir, 'config.json'), '{"device":"laptop"}')

    createDatabase(dbPath).close()

    expect(existsSync(join(dir, 'watermark.json'))).toBe(false)
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).toBe(state)
    expect(readFileSync(join(dir, 'config.json'), 'utf-8')).toBe('{"device":"laptop"}')
  })

  it('opens a healthy database without moving or resetting anything', () => {
    const before = healthyDatabase()
    writeFileSync(join(dir, 'watermark.json'), '{"files":{}}')

    createDatabase(dbPath).close()

    expect(asideFiles()).toEqual([])
    expect(existsSync(join(dir, 'watermark.json'))).toBe(true)
    expect(readFileSync(dbPath).length).toBe(before.length)
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves every file in place and throws when the database cannot be moved', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)
    leaveJournalFiles()
    const wal = readFileSync(dbPath + '-wal')
    fsHooks.failRename = from => from === dbPath

    let opened: Database.Database | undefined
    expect(() => { opened = createDatabase(dbPath) }).toThrow(/could not be moved to .*cache\.db\.corrupt-.*EBUSY/)
    opened?.close()

    // The journal files moved first were put back beside their database.
    expect(files()).toEqual(['cache.db', 'cache.db-shm', 'cache.db-wal'])
    expect(readFileSync(dbPath, 'utf-8')).toBe(NOT_A_DATABASE)
    expect(readFileSync(dbPath + '-wal').equals(wal)).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    // Once the file can be moved, the next run recovers.
    fsHooks.failRename = null
    createDatabase(dbPath).close()
    expect(asideFiles()).toHaveLength(3)
  })

  it.runIf(process.platform === 'win32')('throws without moving anything while another process has the file open (Windows)', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)
    // The widget keeps a read-only connection to the database open.
    const holder = new Database(dbPath, { readonly: true })
    try {
      expect(() => createDatabase(dbPath)).toThrow(/could not be moved to .*(EBUSY|EPERM)/)
      expect(files()).toEqual(['cache.db'])
    } finally {
      holder.close()
    }

    createDatabase(dbPath).close()
    expect(asideFiles()).toHaveLength(1)
  })

  it('leaves the database in place and throws when the cursors cannot be reset', () => {
    writeFileSync(dbPath, NOT_A_DATABASE)
    const watermarkPath = join(dir, 'watermark.json')
    writeFileSync(watermarkPath, '{"files":{}}')
    fsHooks.failUnlink = path => path === watermarkPath

    expect(() => createDatabase(dbPath)).toThrow(/left in place because .*watermark\.json could not be removed/)

    expect(files()).toEqual(['cache.db', 'watermark.json'])
    expect(readFileSync(dbPath, 'utf-8')).toBe(NOT_A_DATABASE)
  })

  it('throws any other error without touching the files', () => {
    // A directory where the database should be: SQLite cannot open it at all.
    mkdirSync(dbPath)
    writeFileSync(join(dir, 'watermark.json'), '{"files":{}}')

    expect(() => createDatabase(dbPath)).toThrow()

    expect(files()).toEqual(['cache.db', 'watermark.json'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('opens the database another process recovered while this one waited for the lock', async () => {
    // A healthy database to stand in for the one the other process creates.
    const recovered = join(dir, 'recovered.db')
    healthyDatabase()
    copyFileSync(dbPath, recovered)
    writeFileSync(dbPath, NOT_A_DATABASE)

    // The other process holds the settings lock (an exclusive transaction on
    // settings.lock, as withSettingsLock takes it), puts its new database in
    // place a moment later, and releases the lock.
    const ready = join(dir, 'other-process-ready')
    const script = `
      const Database = require('better-sqlite3')
      const { copyFileSync, writeFileSync } = require('node:fs')
      const [lockPath, readyPath, from, to] = process.argv.slice(1)
      const lock = new Database(lockPath)
      lock.exec('BEGIN EXCLUSIVE')
      writeFileSync(readyPath, '')
      setTimeout(() => {
        copyFileSync(from, to)
        lock.exec('ROLLBACK')
        lock.close()
      }, 1500)
    `
    const other = spawn(process.execPath, ['-e', script, join(dir, 'settings.lock'), ready, recovered, dbPath], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit' })
    const exited = new Promise<number | null>(resolve => other.on('exit', resolve))
    try {
      for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 50))
      expect(existsSync(ready)).toBe(true)

      const db = createDatabase(dbPath)
      try {
        expectUsable(db)
      } finally {
        db.close()
      }
    } finally {
      expect(await exited).toBe(0)
    }

    expect(asideFiles()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the next parse after a corrupted database was replaced (#93)', () => {
  // tests/setup-home.ts points the home directory at a temporary directory of
  // this test file, so ~/.aiusage below is never the real one.
  const aiusageDir = join(homedir(), '.aiusage')
  const dbPath = join(aiusageDir, 'cache.db')
  let logsDir: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(aiusageDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    logsDir = mkdtempSync(join(tmpdir(), 'aiusage-corrupt-logs-'))
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: 'device-corrupt-test', lastSyncStatus: 'ok' }))
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'claude-code': logsDir } }))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(logsDir, { recursive: true, force: true })
  })

  function writeLog(messages: number): void {
    const projectDir = join(logsDir, '-work-project')
    mkdirSync(projectDir, { recursive: true })
    const lines = Array.from({ length: messages }, (_, i) => JSON.stringify({
      type: 'assistant',
      cwd: '/work/project',
      timestamp: new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString(),
      message: {
        id: `msg_${i}`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `reply ${i}` }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      },
    }))
    writeFileSync(join(projectDir, 'session-a.jsonl'), lines.join('\n') + '\n')
  }

  function recordCount(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n
  }

  it('imports the history again from the logs', async () => {
    writeLog(3)
    let db = createDatabase(dbPath)
    try {
      await runParse(db, 'claude-code')
      expect(recordCount(db)).toBe(3)
    } finally {
      db.close()
    }
    expect(existsSync(join(aiusageDir, 'watermark.json'))).toBe(true)

    writeFileSync(dbPath, NOT_A_DATABASE)

    db = createDatabase(dbPath)
    try {
      expect(recordCount(db)).toBe(0)
      const result = await runParse(db, 'claude-code')
      expect(result.errors).toEqual([])
      expect(recordCount(db)).toBe(3)
    } finally {
      db.close()
    }
  })
})
