import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord, Tool } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import {
  foldLineSeededRecordCopies,
  getRecordById,
  insertRecord,
  markRecordsSynced,
  recordIdsForReread,
  unretirePublishedWireIds,
} from '../../src/db/records.js'
import { DELETED_LOCAL_ROWS } from '../../src/db/sync-claims.js'
import { runParse } from '../../src/commands/parse.js'
import { collapseImporterDuplicates, kiroLogLineId } from '../../src/commands/importer-duplicates.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'

// Before v1.5.22 an installation without sync parsed under the device id
// 'unknown', and record ids are built from the device id. The Kiro token log,
// Cursor transcript and CodeBuddy IDE importers build their ids like every
// importer (recordIdsForReread), so a record stored under the sentinel's id
// keeps that row when its source is read again under the device's id. And the
// one-time importer repair and the folding of copies stored under both ids
// delete only copies, whichever runs first.
// tests/setup-home.ts gives this file its own home directory.

const aiusageDir = join(homedir(), '.aiusage')
const watermarkPath = join(aiusageDir, 'watermark.json')
const projectsDir = join(homedir(), '.cursor', 'projects')
const DEVICE = '11111111-2222-3333-4444-555555555555'
const SOURCE_OVERRIDES = ['AIUSAGE_KIRO_PATH', 'AIUSAGE_CURSOR_PATH', 'AIUSAGE_CODEBUDDY_IDE_PATH', 'AIUSAGE_CODEBUDDY_PATH', 'CODEBUDDY_HOME', 'KIRO_HOME']

interface Row {
  id: string
  ts: number
  updated_at: number
  input_tokens: number
  output_tokens: number
  device_instance_id: string
}

let db: Database.Database
let scratch: string
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
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
  rmSync(aiusageDir, { recursive: true, force: true })
  rmSync(projectsDir, { recursive: true, force: true })
  mkdirSync(aiusageDir, { recursive: true })
  scratch = mkdtempSync(join(tmpdir(), 'aiu-dedup-unknown-'))
  db = new Database(':memory:')
  initializeDatabase(db)
})

afterEach(() => {
  db.close()
  rmSync(scratch, { recursive: true, force: true })
  rmSync(projectsDir, { recursive: true, force: true })
})

function configure(sources: Record<string, string>): void {
  writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources }))
}

/** What every command of v1.5.22 and later does first. */
function giveDevice(): void {
  writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: DEVICE }))
}

function rows(tool: Tool): Row[] {
  return db.prepare(
    'SELECT id, ts, updated_at, input_tokens, output_tokens, device_instance_id FROM records WHERE tool = ? ORDER BY id',
  ).all(tool) as Row[]
}

function queue(): Array<{ target: string; wire_id: string }> {
  return db.prepare('SELECT target, wire_id FROM sync_retired_wire_ids ORDER BY target, wire_id').all() as Array<{ target: string; wire_id: string }>
}

describe('a record of the new ids stored before the installation had a device id', () => {
  it('Kiro token log: a line keeps its row when the log is read from the start again', async () => {
    const root = join(scratch, 'kiro')
    mkdirSync(root, { recursive: true })
    const log = join(root, 'tokens_generated.jsonl')
    const request = (promptTokens: number, timestamp: string) =>
      JSON.stringify({ model: 'claude-sonnet-4', provider: 'kiro', promptTokens, generatedTokens: 10, timestamp })
    const lines = [request(100, '2026-09-01T00:00:00Z'), request(200, '2026-09-01T00:01:00Z')]
    writeFileSync(log, lines.map(line => line + '\n').join(''))
    configure({ kiro: root })

    // No state.json yet: ids are built from 'unknown'.
    await runParse(db, 'kiro')
    const before = rows('kiro')
    let offset = 0
    const lineIds = lines.map(line => {
      const id = kiroLogLineId({ deviceInstanceId: 'unknown' }, log, offset, line)
      offset += Buffer.byteLength(line) + 1
      return id
    })
    expect(before.map(r => r.id)).toEqual([...lineIds].sort())

    // The device gets its id, a third request is logged, and watermark.json is
    // lost, so the whole log is read again under the device's id.
    giveDevice()
    const third = request(400, '2026-09-01T00:02:00Z')
    appendFileSync(log, third + '\n')
    rmSync(watermarkPath)
    await runParse(db, 'kiro')

    const after = rows('kiro')
    const thirdId = kiroLogLineId({ deviceInstanceId: DEVICE }, log, offset, third)
    expect(after.map(r => r.id)).toEqual([...lineIds, thirdId].sort())
    // The first two lines are written to the rows they are stored under, unchanged.
    expect(after.filter(r => r.id !== thirdId)).toEqual(before.map(r => ({ ...r, device_instance_id: DEVICE })))
    expect(after.reduce((total, r) => total + r.input_tokens, 0)).toBe(700)
    // Nothing was deleted, so nothing is retracted.
    expect(queue()).toEqual([])
  })

  it('Cursor agent transcript: the estimate keeps its row when the transcript grows', async () => {
    const transcriptDir = join(projectsDir, 'my-project', 'agent-transcripts', 'composer-1')
    mkdirSync(transcriptDir, { recursive: true })
    const transcript = join(transcriptDir, 'composer-1.jsonl')
    let clock = 1_780_000_000
    const say = (role: 'user' | 'assistant', tokens: number) => {
      appendFileSync(transcript, JSON.stringify({ role, message: { content: [{ type: 'text', text: 'a'.repeat(tokens * 3) }] } }) + '\n')
      clock += 60
      utimesSync(transcript, clock, clock)
    }
    const cursorDbPath = join(scratch, 'state.vscdb')

    say('user', 100)
    say('assistant', 200)
    await runParse(db, 'cursor', { cursorDbPath })
    const [before] = rows('cursor')
    expect(before.id).toBe(generateRecordId('unknown', transcript, 0))

    giveDevice()
    say('assistant', 100)
    await runParse(db, 'cursor', { cursorDbPath })

    expect(rows('cursor')).toMatchObject([{ id: before.id, input_tokens: 100, output_tokens: 300, device_instance_id: DEVICE }])
    expect(queue()).toEqual([])
  })

  it('CodeBuddy IDE: the conversation keeps its row when a turn is added', async () => {
    const dataDir = join(scratch, 'cb-data')
    const conversation = join(dataDir, 'default', 'CodeBuddyIDE', 'ws', 'history', 'session-1', 'conv-1')
    const turn = (n: number, createdAt: string, cacheMissTokens: number, lastOutputTokens: number) => {
      mkdirSync(join(conversation, 'messages'), { recursive: true })
      writeFileSync(join(conversation, 'messages', `turn-${n}.json`), JSON.stringify({
        role: 'assistant', message: '{}', id: `a-${n}`, createdAt,
        extra: JSON.stringify({ modelId: 'deepseek-v4-flash', statsSnapshot: { cachedInputTokens: 0, cacheMissTokens, lastOutputTokens } }),
      }))
    }
    configure({ 'codebuddy-ide': dataDir })

    turn(1, '2026-07-01T06:00:00.000Z', 1000, 50)
    await runParse(db, 'codebuddy')
    const [before] = rows('codebuddy')
    expect(before.id).toBe(generateRecordId('unknown', conversation, 0))

    giveDevice()
    turn(2, '2026-07-01T07:00:00.000Z', 2500, 80)
    await runParse(db, 'codebuddy')

    expect(rows('codebuddy')).toMatchObject([{ id: before.id, input_tokens: 2500, output_tokens: 80, device_instance_id: DEVICE }])
    expect(queue()).toEqual([])
  })
})

describe('the one-time importer repair and the folding of copies', () => {
  const T0 = 1_780_000_000_000
  const T1 = T0 + 3_600_000

  function record(tool: Tool, id: string, sourceFile: string, ts: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
    return {
      id, ts, ingestedAt: ts, updatedAt: ts, lineOffset: 0,
      tool, model: 'm', provider: 'p',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
      cost: 0, costSource: 'unknown', sessionId: 's', sourceFile, device: 'laptop', deviceInstanceId: DEVICE,
      ...overrides,
    }
  }

  /**
   * A database as v1.5.23 leaves it on an installation that read a Kiro token
   * log, a Cursor transcript and a CodeBuddy IDE conversation before it had a
   * device id, with the old, time-based ids. The rows were relabelled to the
   * device. Each source was then read again under the device's id: once with
   * the same file time (a lost watermark: a copy under the device's id of each
   * sentinel row) and once after it grew. None of the sources exists any
   * more. The cloud acknowledged every row.
   */
  function seed(): StatsRecord[] {
    const log = join(scratch, 'gone', 'tokens_generated.jsonl')
    const transcript = join(scratch, 'gone', 'agent-transcripts', 'c-1', 'c-1.jsonl')
    const conversation = join(scratch, 'gone', 'CodeBuddyIDE', 'history', 'conv-1')
    const kiro = (seedDevice: string, offset: number, mtime: number, updatedAt: number) =>
      record('kiro', generateRecordId(seedDevice, `${log}:${offset}`, mtime), log, mtime, { lineOffset: offset, updatedAt })
    const estimate = (seedDevice: string, mtime: number, input: number, output: number, updatedAt: number) =>
      record('cursor', generateRecordId(seedDevice, transcript, mtime), transcript, mtime, { inputTokens: input, outputTokens: output, updatedAt })
    const snapshot = (seedDevice: string, ts: number, input: number, updatedAt: number) =>
      record('codebuddy', generateRecordId(seedDevice, conversation, ts), conversation, ts, { inputTokens: input, updatedAt })
    const rows = [
      kiro('unknown', 0, T0, T0), kiro('unknown', 80, T0, T0),
      kiro(DEVICE, 0, T0, T0 + 10), kiro(DEVICE, 80, T0, T0 + 10),
      kiro(DEVICE, 0, T1, T1), kiro(DEVICE, 80, T1, T1), kiro(DEVICE, 160, T1, T1),
      estimate('unknown', T0, 50, 100, T0), estimate(DEVICE, T0, 50, 100, T0 + 10), estimate(DEVICE, T1, 80, 150, T1),
      snapshot('unknown', T0, 1000, T0), snapshot(DEVICE, T0, 1000, T0 + 10), snapshot(DEVICE, T1, 2500, T1),
    ]
    for (const row of rows) insertRecord(db, row)
    markRecordsSynced(db, rows.map(row => row.id), T1 + 1, 'cloud')
    return rows
  }

  /** The folds a release with recordIdsForReread makes when it reads each source again with the old ids. */
  function foldOldIds(): void {
    const { recordId } = recordIdsForReread(db, DEVICE)
    for (const row of db.prepare('SELECT source_file, line_offset, tool FROM records').all() as Array<{ source_file: string; line_offset: number; tool: Tool }>) {
      const seedOf = row.tool === 'kiro' ? `${row.source_file}:${row.line_offset}` : row.source_file
      recordId(seedOf, T0)
    }
  }

  function check(seeded: StatsRecord[]): { ids: string[]; queue: Array<{ target: string; wire_id: string }> } {
    // One row per request, transcript and conversation: the latest of each.
    expect(rows('kiro').map(r => r.input_tokens)).toEqual([100, 100, 100])
    expect(rows('cursor').map(r => [r.input_tokens, r.output_tokens])).toEqual([[80, 150]])
    expect(rows('codebuddy').map(r => r.input_tokens)).toEqual([2500])
    const remaining = (db.prepare('SELECT id FROM records').pluck().all() as string[]).map(id => getRecordById(db, id)!)
    const published = new Set(remaining.map(row => mapStatsRecordToSyncRecord(row).id))
    // No queued id is one a remaining row is published under...
    expect(queue().filter(entry => published.has(entry.wire_id))).toEqual([])
    expect(unretirePublishedWireIds(db, 'cloud', DEVICE)).toBe(0)
    // ...and every deleted row the cloud holds is retracted there, unless a
    // remaining row took over its wire id (the CodeBuddy snapshots share one).
    const cloud = new Set(queue().filter(entry => entry.target === 'cloud').map(entry => entry.wire_id))
    for (const row of seeded) {
      const wireId = mapStatsRecordToSyncRecord(row).id
      if (getRecordById(db, row.id) || published.has(wireId)) continue
      expect(cloud.has(wireId)).toBe(true)
    }
    // Neither the line-seeded fold of migration v17 nor a second repair finds anything more.
    expect(foldLineSeededRecordCopies(db)).toBe(0)
    expect(collapseImporterDuplicates(db)).toEqual({ kiro: 0, cursor: 0, codebuddy: 0 })
    return { ids: remaining.map(row => row.id).sort(), queue: queue() }
  }

  it('delete only copies and retract no published id, whichever runs first', () => {
    const seeded = seed()
    // Migration v17 runs first in every order: none of these ids is built from the file and line.
    expect(foldLineSeededRecordCopies(db)).toBe(0)
    foldOldIds()
    expect(collapseImporterDuplicates(db)).toEqual({ kiro: 2, cursor: 1, codebuddy: 1 })
    const foldFirst = check(seeded)

    db.close()
    db = new Database(':memory:')
    initializeDatabase(db)
    seed()
    expect(collapseImporterDuplicates(db)).toEqual({ kiro: 4, cursor: 2, codebuddy: 2 })
    foldOldIds()
    const repairFirst = check(seeded)

    expect(repairFirst.ids).toEqual(foldFirst.ids)
  })
})

describe('unretirePublishedWireIds', () => {
  it('drops a published id from the target and from the deleted-rows list, also for a row not yet relabelled', () => {
    const conversation = join(scratch, 'CodeBuddyIDE', 'history', 'conv-1')
    insertRecord(db, {
      id: 'kiro-live', ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0, tool: 'kiro', model: 'm', provider: 'p',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0,
      costSource: 'unknown', sessionId: 's', sourceFile: 'log.jsonl', device: 'laptop', deviceInstanceId: DEVICE,
    })
    // Still labelled 'unknown': once relabelled it is published under the device's generated wire id.
    insertRecord(db, {
      id: generateRecordId('unknown', conversation, 0), ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0, tool: 'codebuddy',
      model: 'm', provider: 'p', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
      cost: 0, costSource: 'unknown', sessionId: 's', sourceFile: conversation, device: 'laptop', deviceInstanceId: 'unknown',
    })
    const codebuddyWireId = generateRecordId(DEVICE, conversation, 0)
    const put = db.prepare('INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)')
    for (const [target, wireId] of [
      ['cloud', 'kiro-live'], [DELETED_LOCAL_ROWS, 'kiro-live'], [DELETED_LOCAL_ROWS, codebuddyWireId],
      ['cloud', 'gone'], [DELETED_LOCAL_ROWS, 'gone'], ['github', 'kiro-live'],
    ]) put.run(target, wireId)

    expect(unretirePublishedWireIds(db, 'cloud', DEVICE)).toBe(3)
    // Another target's queue is that target's to clear.
    expect(queue()).toEqual([
      { target: DELETED_LOCAL_ROWS, wire_id: 'gone' },
      { target: 'cloud', wire_id: 'gone' },
      { target: 'github', wire_id: 'kiro-live' },
    ])
    expect(unretirePublishedWireIds(db, 'cloud', DEVICE)).toBe(0)
  })
})
