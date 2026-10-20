import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatsRecord } from '@aiusage/core'
import { runParseAntigravity } from '../../src/commands/parse-antigravity.js'
import { runParse } from '../../src/commands/parse.js'
import { initializeDatabase } from '../../src/db/index.js'
import { markRecordsSynced } from '../../src/db/records.js'

// Usage stored in steps after the last generation's linked steps (#78).

function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function field(number: number, value: number | Buffer | string): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)])
  const data = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data])
}

function message(...fields: Array<Buffer | undefined>): Buffer {
  return Buffer.concat(fields.filter((value): value is Buffer => value != null))
}

function usage(options: { modelId?: number; input: number; output: number; responseId: string }): Buffer {
  return message(
    options.modelId ? field(1, options.modelId) : undefined,
    field(2, options.input),
    field(3, options.output),
    field(10, options.output),
    field(11, options.responseId),
  )
}

function generation(options: { model?: string; modelId?: number; usage?: Buffer; stepIndices: number[] }): Buffer {
  const chatModel = message(
    options.modelId ? field(3, options.modelId) : undefined,
    options.usage ? field(4, options.usage) : undefined,
    options.model ? field(19, options.model) : undefined,
  )
  return message(field(1, chatModel), field(2, Buffer.concat(options.stepIndices.map(varint))))
}

function step(ts: number, stepUsage?: Buffer): Buffer {
  return message(
    field(1, message(field(1, Math.floor(ts / 1000)), field(2, (ts % 1000) * 1_000_000))),
    stepUsage ? field(9, stepUsage) : undefined,
  )
}

const SCHEMA = `
  CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);
  CREATE TABLE steps (idx INTEGER, metadata BLOB);
`

/** The conversation's main model and the helper model Antigravity calls after a response. */
const MAIN = { model: 'gemini-3.6-flash', modelId: 1264 }
const HELPER_ID = 1050
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0)

const response = (responseId: string, input: number, output: number): Buffer =>
  usage({ modelId: MAIN.modelId, input, output, responseId })
const helper = (responseId: string, input: number, output: number): Buffer =>
  usage({ modelId: HELPER_ID, input, output, responseId })

type Store = Map<string, StatsRecord>

/** What the records table holds after writing `records`: rows are upserted by id. */
function upsert(store: Store, records: StatsRecord[]): Store {
  for (const record of records) store.set(record.id, record)
  return store
}

function contents(store: Store): Array<[string, string, number, number, number]> {
  return [...store.values()]
    .map((record): [string, string, number, number, number] => [record.id, record.model, record.inputTokens, record.outputTokens, record.ts])
    .sort(([a], [b]) => a.localeCompare(b))
}

describe('parse-antigravity trailing steps (#78)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(SCHEMA)
  })

  afterEach(() => db.close())

  function parse(startIndex = 0) {
    return runParseAntigravity(db, {
      dbPath: '/home/test/.gemini/antigravity/conversations/session-1.db',
      device: 'laptop',
      deviceInstanceId: 'device-123',
      now: Date.UTC(2026, 8, 7),
      fallbackTs: Date.UTC(2026, 8, 7),
      startIndex,
    })
  }

  function insertGeneration(index: number, data: Buffer): void {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(index, data, data.length)
  }

  function updateGeneration(index: number, data: Buffer): void {
    db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?').run(data, data.length, index)
  }

  function insertStep(index: number, data: Buffer): void {
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(index, data)
  }

  /** A first turn as Antigravity writes it: input steps, the response step, the generation. */
  function firstTurn(): void {
    insertStep(0, step(T0))
    insertStep(1, step(T0 + 1_000))
    insertStep(2, step(T0 + 2_000, response('r0', 10_408, 849)))
    insertGeneration(0, generation({ ...MAIN, usage: response('r0', 10_408, 849), stepIndices: [2] }))
  }

  it('imports usage a step after the last generation\'s linked steps stores', () => {
    firstTurn()
    insertStep(3, step(T0 + 3_000, helper('h0', 50, 4)))

    const result = parse()

    expect(result.errors).toEqual([])
    expect(result.nextIndex).toBe(1)
    expect(result.records.map((record) => [record.model, record.inputTokens, record.outputTokens, record.ts])).toEqual([
      [MAIN.model, 10_408, 849, T0 + 2_000],
      [`antigravity-model-${HELPER_ID}`, 50, 4, T0 + 3_000],
    ])
  })

  it('reads trailing steps again on every import, so usage written after the cursor passed the last generation is imported', () => {
    firstTurn()
    const store = upsert(new Map(), parse().records)
    expect(store.size).toBe(1)

    insertStep(3, step(T0 + 3_000, helper('h0', 50, 4)))
    const second = parse(1)
    expect(second.nextIndex).toBe(1)
    expect(second.records.map((record) => [record.model, record.inputTokens])).toEqual([[`antigravity-model-${HELPER_ID}`, 50]])
    upsert(store, second.records)
    expect(contents(store)).toEqual(contents(upsert(new Map(), parse().records)))

    // A second trailing step: both are emitted again under the same ids, so
    // the first one is rewritten in place rather than added twice.
    insertStep(4, step(T0 + 4_000, helper('h1', 60, 5)))
    const third = parse(1)
    expect(third.nextIndex).toBe(1)
    expect(third.records.map((record) => record.inputTokens)).toEqual([50, 60])
    expect(third.records[0].id).toBe(second.records[0].id)
    upsert(store, third.records)
    expect(store.size).toBe(3)
    expect(contents(store)).toEqual(contents(upsert(new Map(), parse().records)))
  })

  it('rewrites trailing usage in place once a later generation\'s window covers it', () => {
    firstTurn()
    insertStep(3, step(T0 + 3_000, helper('h0', 50, 4)))
    const store = upsert(new Map(), parse().records)
    const trailingId = [...store.values()].find((record) => record.inputTokens === 50)!.id

    // The conversation continues: the next turn's generation links steps
    // beyond step 3, so step 3 now sits in its window.
    insertStep(4, step(T0 + 4_000))
    insertStep(5, step(T0 + 5_000, response('r1', 20_000, 300)))
    insertGeneration(1, generation({ ...MAIN, usage: response('r1', 20_000, 300), stepIndices: [5] }))

    const incremental = parse(1)
    expect(incremental.nextIndex).toBe(2)
    expect(incremental.records.map((record) => record.inputTokens)).toEqual([50, 20_000])
    expect(incremental.records[0].id).toBe(trailingId)
    upsert(store, incremental.records)
    expect(store.size).toBe(3)
    expect(contents(store)).toEqual(contents(upsert(new Map(), parse().records)))
  })

  it('gives trailing usage to the last settled generation while the latest one is still being written', () => {
    firstTurn()
    const store = upsert(new Map(), parse().records)

    // Generation 1 has no usage yet, so it is held back; usage in a step
    // after its linked steps neither settles it nor waits for it.
    insertStep(3, step(T0 + 3_000))
    insertGeneration(1, generation({ ...MAIN, stepIndices: [3] }))
    insertStep(4, step(T0 + 4_000, helper('h0', 50, 4)))

    const heldBack = parse(1)
    expect(heldBack.nextIndex).toBe(1)
    expect(heldBack.records.map((record) => [record.model, record.inputTokens])).toEqual([[`antigravity-model-${HELPER_ID}`, 50]])
    upsert(store, heldBack.records)
    const full = parse()
    expect(full.nextIndex).toBe(1)
    expect(contents(store)).toEqual(contents(upsert(new Map(), full.records)))

    updateGeneration(1, generation({ ...MAIN, usage: response('r1', 20_000, 300), stepIndices: [3] }))
    const settled = parse(1)
    expect(settled.nextIndex).toBe(2)
    expect(settled.records.map((record) => record.inputTokens)).toEqual([20_000, 50])
    expect(settled.records[1].id).toBe(heldBack.records[0].id)
    upsert(store, settled.records)
    expect(store.size).toBe(3)
    expect(contents(store)).toEqual(contents(upsert(new Map(), parse().records)))
  })

  it('waits for a settled generation before importing trailing usage', () => {
    insertStep(0, step(T0))
    insertGeneration(0, generation({ ...MAIN, stepIndices: [0] }))
    insertStep(1, step(T0 + 1_000, response('r0', 10_408, 849)))

    const unsettled = parse()
    expect(unsettled.records).toEqual([])
    expect(unsettled.nextIndex).toBe(0)

    updateGeneration(0, generation({ ...MAIN, usage: response('r0', 10_408, 849), stepIndices: [0] }))
    const settled = parse()
    expect(settled.nextIndex).toBe(1)
    // The step's copy of the response is merged with the generation's.
    expect(settled.records.map((record) => [record.model, record.inputTokens])).toEqual([[MAIN.model, 10_408]])
  })

  it('keeps the copy a later window keeps when a trailing step repeats an earlier response under another id', () => {
    // Only the generation row stores its response, under its own id; a
    // trailing step repeats the response under the helper's id. The two
    // cannot both be right: the copy seen first is kept. Trailing steps are
    // read after every window's rows, which is where they sit once a later
    // generation's window covers them, so the record does not change when
    // that happens.
    insertStep(0, step(T0))
    insertStep(1, step(T0 + 1_000))
    insertGeneration(0, generation({ ...MAIN, usage: response('r0', 10_408, 849), stepIndices: [1] }))
    insertStep(3, step(T0 + 3_000, helper('r0', 70, 6)))
    const before = parse().records
    expect(before.map((record) => [record.model, record.inputTokens])).toEqual([[MAIN.model, 10_408]])

    insertStep(4, step(T0 + 4_000, response('r1', 20_000, 300)))
    insertGeneration(1, generation({ ...MAIN, usage: response('r1', 20_000, 300), stepIndices: [4] }))
    const after = parse().records
    expect(after.map((record) => [record.id, record.model, record.inputTokens])).toEqual([
      [before[0].id, MAIN.model, 10_408],
      [after[1].id, MAIN.model, 20_000],
    ])
  })

  it('names trailing usage that carries no model id after the last settled generation', () => {
    firstTurn()
    insertStep(3, step(T0 + 3_000, usage({ input: 400, output: 40, responseId: 'r-late' })))

    const records = parse().records

    expect(records.map((record) => [record.model, record.inputTokens])).toEqual([[MAIN.model, 10_408], [MAIN.model, 400]])
  })
})

describe('runParse with Antigravity trailing steps (#78)', () => {
  const aiusageDir = join(homedir(), '.aiusage')
  let db: Database.Database
  let conversationsDir: string
  let conversation: Database.Database

  beforeEach(() => {
    rmSync(aiusageDir, { recursive: true, force: true })
    mkdirSync(aiusageDir, { recursive: true })
    conversationsDir = join(mkdtempSync(join(tmpdir(), 'aiusage-ag-trailing-')), 'conversations')
    mkdirSync(conversationsDir)
    writeFileSync(join(aiusageDir, 'state.json'), JSON.stringify({ deviceInstanceId: 'device-trailing' }))
    writeFileSync(join(aiusageDir, 'config.json'), JSON.stringify({ sources: { antigravity: conversationsDir } }))
    db = new Database(':memory:')
    initializeDatabase(db)
    conversation = new Database(join(conversationsDir, 'session-1.db'))
    conversation.exec(SCHEMA)
  })

  afterEach(() => {
    conversation.close()
    db.close()
    rmSync(join(conversationsDir, '..'), { recursive: true, force: true })
  })

  function rows(): Array<{ id: string; input_tokens: number; updated_at: number; synced_at: number | null }> {
    return db.prepare('SELECT id, input_tokens, updated_at, synced_at FROM records ORDER BY ts').all() as Array<{ id: string; input_tokens: number; updated_at: number; synced_at: number | null }>
  }

  it('imports trailing usage on the next run and leaves it untouched on the runs after', async () => {
    conversation.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(0, step(T0))
    conversation.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, step(T0 + 1_000, response('r0', 10_408, 849)))
    const data = generation({ ...MAIN, usage: response('r0', 10_408, 849), stepIndices: [1] })
    conversation.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, data, data.length)

    await runParse(db, 'antigravity')
    expect(rows().map((row) => row.input_tokens)).toEqual([10_408])

    conversation.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(2, step(T0 + 2_000, helper('h0', 50, 4)))
    await runParse(db, 'antigravity')
    const imported = rows()
    expect(imported.map((row) => row.input_tokens)).toEqual([10_408, 50])

    // Reading the trailing step again writes nothing: the row keeps its
    // version and stays synced.
    markRecordsSynced(db, imported.map((row) => row.id), imported[1].updated_at)
    const synced = rows()
    await runParse(db, 'antigravity')
    expect(rows()).toEqual(synced)
    expect(rows()[1].synced_at).toBe(imported[1].updated_at)
  })
})
