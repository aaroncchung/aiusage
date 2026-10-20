import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord, Tool } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, markRecordsSynced } from '../../src/db/records.js'
import { runParse } from '../../src/commands/parse.js'
import { collapseImporterDuplicates, kiroLogLineId, repairImporterDuplicates } from '../../src/commands/importer-duplicates.js'
import { CURRENT_IMPORTER_DEDUP_VERSION, WatermarkManager } from '../../src/watermark.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { FakeSyncBackend } from '../sync/helpers/fake-backend.js'

// tests/setup-home.ts gives this file its own home directory.
const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const projectsDir = join(homedir(), '.cursor', 'projects')
const DEVICE = 'device-a'
const PEER = 'device-b'
const T0 = 1_780_000_000_000
// Source overrides inherited from the environment would win over the fixtures.
const SOURCE_OVERRIDES = ['AIUSAGE_KIRO_PATH', 'AIUSAGE_CURSOR_PATH', 'AIUSAGE_CODEBUDDY_IDE_PATH', 'AIUSAGE_CODEBUDDY_PATH', 'CODEBUDDY_HOME', 'KIRO_HOME']

function record(tool: Tool, id: string, sourceFile: string, ts: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id, ts, ingestedAt: ts, updatedAt: ts, lineOffset: 0,
    tool, model: 'm', provider: 'p',
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'unknown', sessionId: 's', sourceFile, device: 'laptop', deviceInstanceId: DEVICE,
    ...overrides,
  }
}

/** A Kiro log line as the old importer stored it: keyed on the file time of the parse that read it. */
function oldKiro(path: string, lineOffset: number, mtime: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return record('kiro', generateRecordId(DEVICE, `${path}:${lineOffset}`, mtime), path, mtime, {
    lineOffset, model: 'claude-sonnet-4', provider: 'kiro', ...overrides,
  })
}

/** A Cursor transcript estimate as the old importer stored it. */
function oldTranscript(path: string, mtime: number, input: number, output: number): StatsRecord {
  return record('cursor', generateRecordId(DEVICE, path, mtime), path, mtime, { inputTokens: input, outputTokens: output })
}

/** A CodeBuddy IDE conversation snapshot as the old importer stored it. */
function oldConversation(dir: string, ts: number, input: number): StatsRecord {
  return record('codebuddy', generateRecordId(DEVICE, dir, ts), dir, ts, { inputTokens: input })
}

describe('importer duplicates', () => {
  let scratch: string
  let db: Database.Database
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    // Keep the default Kiro and CodeBuddy locations inside the test home on every platform.
    for (const key of ['APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', ...SOURCE_OVERRIDES]) savedEnv[key] = process.env[key]
    for (const key of SOURCE_OVERRIDES) delete process.env[key]
    process.env.APPDATA = join(homedir(), 'AppData', 'Roaming')
    process.env.XDG_DATA_HOME = join(homedir(), '.local', 'share')
    process.env.XDG_CONFIG_HOME = join(homedir(), '.config')
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aiu-dedup-'))
    rmSync(aiusageDir, { recursive: true, force: true })
    rmSync(projectsDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
    rmSync(scratch, { recursive: true, force: true })
    rmSync(projectsDir, { recursive: true, force: true })
  })

  const count = (where = '1 = 1') => (db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get() as { n: number }).n
  const sum = (column: string, where = '1 = 1') =>
    (db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM records WHERE ${where}`).get() as { n: number }).n
  const ids = (where = '1 = 1') =>
    (db.prepare(`SELECT id FROM records WHERE ${where} ORDER BY id`).all() as Array<{ id: string }>).map(r => r.id)

  /** Three parses of a growing Kiro log (2, 3 and 4 lines), as the old importer left them: 9 rows. */
  function seedKiroGenerations(path: string, lineLength = 80): StatsRecord[] {
    const rows: StatsRecord[] = []
    for (const [generation, lines] of [2, 3, 4].entries()) {
      for (let line = 0; line < lines; line++) rows.push(oldKiro(path, line * lineLength, T0 + generation * 60_000))
    }
    for (const row of rows) insertRecord(db, row)
    return rows
  }

  describe('collapseImporterDuplicates', () => {
    it('keeps every line of a Kiro token log whose newest parse did not store all of them', () => {
      const path = join(scratch, 'gone', 'tokens_generated.jsonl')
      // An earlier parse stored three lines; the latest one was interrupted after the first.
      for (const offset of [0, 80, 160]) insertRecord(db, oldKiro(path, offset, T0))
      const latest = oldKiro(path, 0, T0 + 60_000)
      insertRecord(db, latest)

      expect(collapseImporterDuplicates(db).kiro).toBe(1)
      expect(ids()).toEqual([latest.id, oldKiro(path, 80, T0).id, oldKiro(path, 160, T0).id].sort())
      expect(sum('input_tokens')).toBe(300)
    })

    it('keeps different Kiro requests that sit at the same offset of a log that was replaced', () => {
      const path = join(scratch, 'tokens_generated.jsonl')
      // Two parses of the first log, then two parses of the log that replaced it.
      insertRecord(db, oldKiro(path, 0, T0))
      insertRecord(db, oldKiro(path, 0, T0 + 60_000))
      const first = oldKiro(path, 0, T0 + 120_000)
      insertRecord(db, first)
      insertRecord(db, oldKiro(path, 0, T0 + 180_000, { inputTokens: 200 }))
      const second = oldKiro(path, 0, T0 + 240_000, { inputTokens: 200 })
      insertRecord(db, second)
      const otherModel = oldKiro(path, 0, T0 + 300_000, { model: 'claude-opus-4' })
      insertRecord(db, otherModel)

      expect(collapseImporterDuplicates(db).kiro).toBe(3)
      expect(ids()).toEqual([first.id, second.id, otherModel.id].sort())
      expect(sum('input_tokens')).toBe(400)
    })

    it('keeps the newest parse of a Kiro token log and deletes the earlier ones', () => {
      const path = join(scratch, 'gone', 'tokens_generated.jsonl')
      const rows = seedKiroGenerations(path)
      expect(sum('input_tokens')).toBe(900)

      expect(collapseImporterDuplicates(db)).toEqual({ kiro: 5, cursor: 0, codebuddy: 0 })
      expect(sum('input_tokens')).toBe(400)
      expect(ids()).toEqual(rows.slice(5).map(r => r.id).sort())

      // Nothing more to delete on a second run.
      expect(collapseImporterDuplicates(db)).toEqual({ kiro: 0, cursor: 0, codebuddy: 0 })
      expect(count()).toBe(4)
    })

    it('leaves Kiro rows stored under the new ids alone, whatever their time', () => {
      const path = join(scratch, 'tokens_generated.jsonl')
      seedKiroGenerations(path)
      // Lines read after the upgrade: one record each, each with its own time.
      for (const [i, ts] of [T0 - 5_000, T0 + 500_000, T0 + 900_000].entries()) {
        insertRecord(db, record('kiro', kiroLogLineId(DEVICE, path, 400 + i * 80, 'line'), path, ts, { lineOffset: 400 + i * 80 }))
      }
      // A line parsed before `init` and relabelled to the device afterwards.
      insertRecord(db, record('kiro', kiroLogLineId('unknown', path, 800, 'line'), path, T0 - 9_000, { lineOffset: 800 }))

      expect(collapseImporterDuplicates(db).kiro).toBe(5)
      expect(count()).toBe(4 + 3 + 1)
    })

    it('does not touch other Kiro sources or rows pulled from another device', () => {
      const log = join(scratch, 'tokens_generated.jsonl')
      seedKiroGenerations(log)
      const session = join(scratch, 'session.json')
      insertRecord(db, record('kiro', 'session-1', session, T0))
      insertRecord(db, record('kiro', 'session-2', session, T0 + 1))
      insertRecord(db, record('kiro', 'sqlite-1', join(scratch, 'devdata.sqlite'), T0))
      insertRecord(db, record('kiro', 'sqlite-2', join(scratch, 'devdata.sqlite'), T0 + 1))
      for (const ts of [T0, T0 + 60_000]) {
        insertRecord(db, oldKiro(log, 0, ts, { id: `peer-${ts}`, origin: 'synced', deviceInstanceId: PEER }))
      }

      collapseImporterDuplicates(db)
      expect(count(`source_file = '${session.replace(/'/g, "''")}'`)).toBe(2)
      expect(count(`id LIKE 'sqlite-%'`)).toBe(2)
      expect(count(`origin = 'synced'`)).toBe(2)
      expect(count(`origin = 'local' AND source_file LIKE '%.jsonl'`)).toBe(4)
    })

    it('keeps the complete estimate of a Cursor transcript over a larger partial one', () => {
      const path = join(scratch, 'p', 'agent-transcripts', 'c1', 'c1.jsonl')
      insertRecord(db, oldTranscript(path, T0, 100, 300))
      // Later parses: a complete one, then one that lost the assistant lines but saw more user text.
      const complete = oldTranscript(path, T0 + 60_000, 600, 300)
      insertRecord(db, complete)
      insertRecord(db, oldTranscript(path, T0 + 120_000, 600, 0))

      expect(collapseImporterDuplicates(db).cursor).toBe(2)
      expect(ids()).toEqual([complete.id])
    })

    it('keeps the largest estimate of a Cursor transcript', () => {
      const path = join(scratch, 'p', 'agent-transcripts', 'c1', 'c1.jsonl')
      const other = join(scratch, 'p', 'agent-transcripts', 'c2', 'c2.jsonl')
      insertRecord(db, oldTranscript(path, T0, 100, 200))
      insertRecord(db, oldTranscript(path, T0 + 60_000, 100, 300))
      insertRecord(db, oldTranscript(path, T0 + 120_000, 150, 400))
      // A later parse that could not read every line of the transcript.
      insertRecord(db, oldTranscript(path, T0 + 180_000, 150, 0))
      insertRecord(db, oldTranscript(other, T0, 7, 9))
      // Records from state.vscdb are not estimates, and these are other conversations.
      insertRecord(db, record('cursor', 'vscdb-1', join(scratch, 'state.vscdb'), T0, { sessionId: 'c8' }))
      insertRecord(db, record('cursor', 'vscdb-2', join(scratch, 'state.vscdb'), T0 + 1, { sessionId: 'c9' }))

      expect(collapseImporterDuplicates(db)).toEqual({ kiro: 0, cursor: 3, codebuddy: 0 })
      expect(db.prepare(`SELECT input_tokens, output_tokens FROM records WHERE source_file = ?`).all(path))
        .toEqual([{ input_tokens: 150, output_tokens: 400 }])
      expect(count(`source_file LIKE '%c2.jsonl'`)).toBe(1)
      expect(count(`id LIKE 'vscdb-%'`)).toBe(2)
    })

    it('deletes every estimate of a Cursor conversation that is counted from state.vscdb', () => {
      const path = join(scratch, 'p', 'agent-transcripts', 'c1', 'c1.jsonl')
      const other = join(scratch, 'p', 'agent-transcripts', 'c2', 'c2.jsonl')
      insertRecord(db, oldTranscript(path, T0, 100, 200))
      insertRecord(db, oldTranscript(path, T0 + 60_000, 100, 300))
      insertRecord(db, oldTranscript(other, T0, 7, 9))
      insertRecord(db, record('cursor', 'vscdb-1', join(scratch, 'state.vscdb'), T0, { sessionId: 'c1' }))
      // The same conversation counted on another device says nothing about this one.
      insertRecord(db, record('cursor', 'vscdb-peer', join(scratch, 'state.vscdb'), T0, { sessionId: 'c2', origin: 'synced', deviceInstanceId: PEER }))

      expect(collapseImporterDuplicates(db)).toEqual({ kiro: 0, cursor: 2, codebuddy: 0 })
      expect(ids(`source_file LIKE '%agent-transcripts%'`)).toEqual([generateRecordId(DEVICE, other, T0)])
      expect(count(`id LIKE 'vscdb-%'`)).toBe(2)
    })

    it('keeps the latest snapshot of a CodeBuddy IDE conversation and leaves CodeBuddy CLI rows alone', () => {
      const dir = join(scratch, 'CodeBuddyIDE', 'ws', 'history', 's', 'conv-1')
      insertRecord(db, oldConversation(dir, T0, 1000))
      insertRecord(db, oldConversation(dir, T0 + 60_000, 2500))
      insertRecord(db, oldConversation(join(scratch, 'CodeBuddyIDE', 'ws', 'history', 's', 'conv-2'), T0, 400))
      const cli = join(scratch, '.codebuddy', 'projects', 'p', 'session.jsonl')
      insertRecord(db, record('codebuddy', 'cli-1', cli, T0, { lineOffset: 0 }))
      insertRecord(db, record('codebuddy', 'cli-2', cli, T0 + 1, { lineOffset: 240 }))

      expect(collapseImporterDuplicates(db)).toEqual({ kiro: 0, cursor: 0, codebuddy: 1 })
      expect(db.prepare(`SELECT input_tokens FROM records WHERE source_file = ?`).all(dir)).toEqual([{ input_tokens: 2500 }])
      expect(count(`id LIKE 'cli-%'`)).toBe(2)
      expect(count()).toBe(4)
    })

    it('keeps the sync state of the rows it keeps and drops it with the rows it deletes', () => {
      const path = join(scratch, 'tokens_generated.jsonl')
      const rows = seedKiroGenerations(path)
      markRecordsSynced(db, rows.map(r => r.id), T0 + 999_000, 'github:me/data')

      collapseImporterDuplicates(db)
      const state = db.prepare(`SELECT record_id FROM sync_record_state ORDER BY record_id`).all() as Array<{ record_id: string }>
      expect(state.map(s => s.record_id)).toEqual(rows.slice(5).map(r => r.id).sort())
    })
  })

  describe('repairImporterDuplicates', () => {
    it('runs once, makes the three importers read their sources again and records the version', () => {
      const log = join(scratch, 'tokens_generated.jsonl')
      const transcript = join(scratch, 'p', 'agent-transcripts', 'c1', 'c1.jsonl')
      const entry = { offset: 10, size: 10, mtime: 1 }
      // Written as the release before the repair writes it: every current
      // parser version (so load() resets nothing), no importerDedupVersion.
      rmSync(watermarkPath, { force: true })
      const before = new WatermarkManager(watermarkPath)
      before.setEntry('kiro', log, entry)
      before.setEntry('kiro', join(scratch, 'session.json'), entry)
      before.setEntry('cursor', transcript, entry)
      before.setEntry('claude-code', join(scratch, 'a.jsonl'), entry)
      before.setCodeBuddyIdeCursor(12345)
      before.setCursorCursor({ lastCreatedAt: 99, lastId: 'c9' })
      before.save()
      expect(JSON.parse(readFileSync(watermarkPath, 'utf-8')).importerDedupVersion).toBeUndefined()
      seedKiroGenerations(log)

      const wm = new WatermarkManager(watermarkPath)
      expect(wm.getImporterDedupVersion()).toBe(0)
      expect(repairImporterDuplicates(db, wm)).toEqual({ kiro: 5, cursor: 0, codebuddy: 0 })

      const saved = JSON.parse(readFileSync(watermarkPath, 'utf-8'))
      expect(saved.importerDedupVersion).toBe(CURRENT_IMPORTER_DEDUP_VERSION)
      expect(saved.files.kiro).toEqual({ [join(scratch, 'session.json')]: entry })
      expect(saved.files.cursor).toEqual({})
      expect(saved.files['claude-code']).toEqual({ [join(scratch, 'a.jsonl')]: entry })
      expect(saved.codebuddyIde).toBe(0)
      expect(saved.cursor).toEqual({ lastCreatedAt: 99, lastId: 'c9' })

      // A second manager sees the version and leaves everything alone.
      const again = new WatermarkManager(watermarkPath)
      again.setEntry('kiro', log, entry)
      insertRecord(db, oldKiro(log, 0, T0 - 60_000))
      expect(repairImporterDuplicates(db, again)).toBeNull()
      expect(again.getEntry('kiro', log)).toEqual(entry)
      expect(count()).toBe(5)
    })

    it('still runs when watermark.json is missing', () => {
      seedKiroGenerations(join(scratch, 'tokens_generated.jsonl'))
      rmSync(watermarkPath, { force: true })
      const wm = new WatermarkManager(watermarkPath)
      expect(repairImporterDuplicates(db, wm)?.kiro).toBe(5)
      expect(existsSync(watermarkPath)).toBe(true)
      expect(new WatermarkManager(watermarkPath).getImporterDedupVersion()).toBe(CURRENT_IMPORTER_DEDUP_VERSION)
    })
  })

  describe('runParse on a database written before the fix', () => {
    const request = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ model: 'claude-sonnet-4', provider: 'kiro', promptTokens: 100, generatedTokens: 10, ...extra }) + '\n'

    /** watermark.json as the old version left it: every source fully read, no dedup version. */
    function writeOldWatermark(files: Partial<Record<Tool, string[]>>, extra: Record<string, unknown> = {}): void {
      const entries: Record<string, Record<string, unknown>> = {}
      for (const [tool, paths] of Object.entries(files)) {
        entries[tool] = Object.fromEntries(paths!.map(path => {
          const stat = statSync(path)
          return [path, { offset: stat.size, size: stat.size, mtime: stat.mtimeMs }]
        }))
      }
      writeFileSync(watermarkPath, JSON.stringify({ files: entries, ...extra }))
    }

    it('re-imports a Kiro token log that still exists under offset-based ids', async () => {
      const root = join(scratch, 'kiro')
      mkdirSync(root, { recursive: true })
      const log = join(root, 'tokens_generated.jsonl')
      const line = request()
      writeFileSync(log, line.repeat(4))
      writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { kiro: root } }))
      const length = Buffer.byteLength(line, 'utf-8')
      seedKiroGenerations(log, length)
      writeOldWatermark({ kiro: [log] })

      const result = await runParse(db, 'kiro')
      expect(result.errors).toEqual([])
      expect(ids()).toEqual([0, 1, 2, 3].map(i => kiroLogLineId(DEVICE, log, i * length, line.trimEnd())).sort())
      expect(sum('input_tokens')).toBe(400)

      // Nothing left to do on the next parse.
      const again = await runParse(db, 'kiro')
      expect(again.parsedCount).toBe(0)
      expect(count()).toBe(4)
    })

    it('keeps what was stored for Kiro lines that cannot be read again', async () => {
      const root = join(scratch, 'kiro')
      mkdirSync(root, { recursive: true })
      const log = join(root, 'tokens_generated.jsonl')
      const line = request()
      const length = Buffer.byteLength(line, 'utf-8')
      // The log was recreated and holds one request and an unfinished line.
      writeFileSync(log, line + '{')
      writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { kiro: root } }))
      const rows = seedKiroGenerations(log, length)
      writeOldWatermark({ kiro: [log] })

      await runParse(db, 'kiro')
      // Offset 0 was read again; the lines at the other offsets keep their newest old row.
      expect(ids()).toEqual([kiroLogLineId(DEVICE, log, 0, line.trimEnd()), ...rows.slice(6).map(r => r.id)].sort())
      expect(sum('input_tokens')).toBe(400)
    })

    it('does not store a Kiro line twice when it was first read before the device had an id', async () => {
      const root = join(scratch, 'kiro')
      mkdirSync(root, { recursive: true })
      const log = join(root, 'tokens_generated.jsonl')
      const line = request()
      const length = Buffer.byteLength(line, 'utf-8')
      writeFileSync(log, line.repeat(2))
      writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { kiro: root } }))
      // Read before `init` (ids built from 'unknown'), relabelled since; watermark.json was lost.
      for (const i of [0, 1]) {
        insertRecord(db, record('kiro', kiroLogLineId('unknown', log, i * length, line.trimEnd()), log, T0, {
          lineOffset: i * length, model: 'claude-sonnet-4', provider: 'kiro',
        }))
      }

      await runParse(db, 'kiro')
      expect(ids()).toEqual([0, 1].map(i => kiroLogLineId(DEVICE, log, i * length, line.trimEnd())).sort())
    })

    it('keeps a newer CodeBuddy IDE snapshot when only an older message can be read', async () => {
      const dataDir = join(scratch, 'cb-data')
      const conversation = join(dataDir, 'default', 'CodeBuddyIDE', 'ws', 'history', 'session-1', 'conv-1')
      mkdirSync(join(conversation, 'messages'), { recursive: true })
      const latest = Date.parse('2026-07-01T07:00:00.000Z')
      writeFileSync(join(conversation, 'messages', 'turn-1.json'), JSON.stringify({
        role: 'assistant', message: '{}', id: 'a-1', createdAt: '2026-07-01T06:00:00.000Z',
        extra: JSON.stringify({ modelId: 'deepseek-v4-flash', statsSnapshot: { cachedInputTokens: 0, cacheMissTokens: 1000, lastOutputTokens: 50 } }),
      }))
      // The message of the second turn is damaged.
      writeFileSync(join(conversation, 'messages', 'turn-2.json'), '{"role":"assist')
      writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'codebuddy-ide': dataDir } }))
      const stored = oldConversation(conversation, latest, 2500)
      insertRecord(db, stored)
      writeFileSync(watermarkPath, JSON.stringify({ files: {}, codebuddyIde: latest }))

      const result = await runParse(db, 'codebuddy')
      expect(result.parsedCount).toBe(0)
      expect(db.prepare(`SELECT id, input_tokens FROM records`).all()).toEqual([{ id: stored.id, input_tokens: 2500 }])
    })

    it('keeps one copy of a Kiro token log that no longer exists', async () => {
      const gone = join(scratch, 'removed', 'tokens_generated.jsonl')
      const rows = seedKiroGenerations(gone)
      writeFileSync(watermarkPath, JSON.stringify({ files: { kiro: { [gone]: { offset: 320, size: 320, mtime: 1 } } } }))

      await runParse(db, 'kiro')
      expect(ids()).toEqual(rows.slice(5).map(r => r.id).sort())
      expect(sum('input_tokens')).toBe(400)
    })

    it('re-imports a Cursor transcript under its file id and keeps the estimate of one that is gone', async () => {
      const dir = join(projectsDir, 'proj', 'agent-transcripts', 'c1')
      mkdirSync(dir, { recursive: true })
      const transcript = join(dir, 'c1.jsonl')
      writeFileSync(transcript, [
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(300) }] } }),
        JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(900) }] } }),
      ].join('\n') + '\n')
      insertRecord(db, oldTranscript(transcript, T0, 100, 200))
      insertRecord(db, oldTranscript(transcript, T0 + 60_000, 100, 300))
      const gone = join(projectsDir, 'proj', 'agent-transcripts', 'c0', 'c0.jsonl')
      insertRecord(db, oldTranscript(gone, T0, 5, 6))
      insertRecord(db, oldTranscript(gone, T0 + 60_000, 5, 8))
      writeOldWatermark({ cursor: [transcript] })

      const result = await runParse(db, 'cursor', { cursorDbPath: join(scratch, 'no-state.vscdb') })
      expect(result.errors).toEqual([])
      const stored = db.prepare(`SELECT id, source_file, input_tokens, output_tokens FROM records ORDER BY source_file`).all()
      expect(stored).toEqual([
        { id: generateRecordId(DEVICE, gone, T0 + 60_000), source_file: gone, input_tokens: 5, output_tokens: 8 },
        { id: generateRecordId(DEVICE, transcript, 0), source_file: transcript, input_tokens: 100, output_tokens: 300 },
      ].sort((a, b) => (a.source_file < b.source_file ? -1 : 1)))
    })

    it('re-imports a CodeBuddy IDE conversation under its directory id and keeps the snapshot of one that is gone', async () => {
      const dataDir = join(scratch, 'cb-data')
      const conversation = join(dataDir, 'default', 'CodeBuddyIDE', 'ws', 'history', 'session-1', 'conv-1')
      mkdirSync(join(conversation, 'messages'), { recursive: true })
      const latest = Date.parse('2026-07-01T07:00:00.000Z')
      writeFileSync(join(conversation, 'messages', 'turn-2.json'), JSON.stringify({
        role: 'assistant', message: '{}', id: 'a-2', createdAt: '2026-07-01T07:00:00.000Z',
        extra: JSON.stringify({ modelId: 'deepseek-v4-flash', statsSnapshot: { cachedInputTokens: 0, cacheMissTokens: 2500, lastOutputTokens: 80 } }),
      }))
      writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { 'codebuddy-ide': dataDir } }))
      insertRecord(db, oldConversation(conversation, latest - 3_600_000, 1000))
      insertRecord(db, oldConversation(conversation, latest, 2500))
      const gone = join(dataDir, 'default', 'CodeBuddyIDE', 'ws', 'history', 'session-1', 'conv-0')
      insertRecord(db, oldConversation(gone, latest - 7_200_000, 300))
      insertRecord(db, oldConversation(gone, latest - 7_000_000, 700))
      // The old cursor is at the latest message: without the reset nothing would be read.
      writeFileSync(watermarkPath, JSON.stringify({ files: {}, codebuddyIde: latest }))

      const result = await runParse(db, 'codebuddy')
      expect(result.errors).toEqual([])
      const stored = db.prepare(`SELECT id, source_file, input_tokens FROM records ORDER BY input_tokens`).all()
      expect(stored).toEqual([
        { id: generateRecordId(DEVICE, gone, latest - 7_000_000), source_file: gone, input_tokens: 700 },
        { id: generateRecordId(DEVICE, conversation, 0), source_file: conversation, input_tokens: 2500 },
      ])
      expect(JSON.parse(readFileSync(watermarkPath, 'utf-8')).codebuddyIde).toBe(latest)
    })
  })

  describe('file-based sync target', () => {
    it('drops the deleted rows from the device namespace, and a peer prunes its copies', async () => {
      const backend = new FakeSyncBackend()
      const target = 'github:me/data'
      const options = { target, consentVerified: true, knownTargets: [target] }
      const path = join(scratch, 'gone', 'tokens_generated.jsonl')
      const rows = seedKiroGenerations(path)

      const peerDb = new Database(':memory:')
      initializeDatabase(peerDb)
      try {
        const own = () => new SyncOrchestrator(db, backend, { ...options, deviceInstanceId: DEVICE }).sync()
        const peer = () => new SyncOrchestrator(peerDb, backend, { ...options, deviceInstanceId: PEER }).sync()
        const peerInput = () => (peerDb.prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input FROM records WHERE tool = 'kiro'`,
        ).get() as { n: number; input: number })

        expect((await own()).status).toBe('ok')
        expect(backend.linesUnder(DEVICE)).toHaveLength(9)
        expect((await peer()).status).toBe('ok')
        expect(peerInput()).toEqual({ n: 9, input: 900 })

        collapseImporterDuplicates(db)
        const pushed = await own()
        expect(pushed.status).toBe('ok')
        expect(pushed.retiredCount).toBe(5)
        expect(backend.linesUnder(DEVICE).map(line => line.id).sort()).toEqual(rows.slice(5).map(r => r.id).sort())

        const pulled = await peer()
        expect(pulled.status).toBe('ok')
        expect(pulled.prunedCount).toBe(5)
        expect(peerInput()).toEqual({ n: 4, input: 400 })
      } finally {
        peerDb.close()
      }
    })

    it('makes a peer take the CodeBuddy snapshot that is kept, also when the deleted one was the newer version', async () => {
      const backend = new FakeSyncBackend()
      const target = 'github:me/data'
      const options = { target, consentVerified: true, knownTargets: [target] }
      const dir = join(scratch, 'CodeBuddyIDE', 'ws', 'history', 's', 'conv-1')
      // The latest snapshot was stored first; an import that could only read
      // an older message then stored an earlier snapshot with a newer version.
      insertRecord(db, oldConversation(dir, T0 + 60_000, 2500))
      insertRecord(db, { ...oldConversation(dir, T0, 1000), updatedAt: T0 + 120_000 })

      const peerDb = new Database(':memory:')
      initializeDatabase(peerDb)
      try {
        const own = () => new SyncOrchestrator(db, backend, { ...options, deviceInstanceId: DEVICE }).sync()
        const peer = () => new SyncOrchestrator(peerDb, backend, { ...options, deviceInstanceId: PEER }).sync()
        const peerInput = () => peerDb.prepare(`SELECT input_tokens FROM records WHERE tool = 'codebuddy'`).all()

        expect((await own()).status).toBe('ok')
        expect((await peer()).status).toBe('ok')
        expect(peerInput()).toEqual([{ input_tokens: 1000 }])

        expect(collapseImporterDuplicates(db).codebuddy).toBe(1)
        expect((await own()).status).toBe('ok')
        expect(backend.linesUnder(DEVICE).map(line => line.inputTokens)).toEqual([2500])
        expect((await peer()).status).toBe('ok')
        expect(peerInput()).toEqual([{ input_tokens: 2500 }])
      } finally {
        peerDb.close()
      }
    })
  })
})
