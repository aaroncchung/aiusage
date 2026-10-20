import { basename } from 'node:path'
import type Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import { calculateCost, inferProvider, resolvePrice, recordIdFor, type RecordIdBuilder } from '@aiusage/core'

export interface AntigravityImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  fallbackTs: number
  startIndex: number
  exchangeRate?: number
}

export interface AntigravityImportResult {
  records: StatsRecord[]
  nextIndex: number
  errors: string[]
}

interface ProtoField {
  number: number
  wireType: number
  value: number | Buffer
}

interface ModelUsage {
  modelId?: number
  inputTokens: number
  totalOutputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  outputTokens: number
  identities: string[]
}

interface UsageEvent {
  usage: ModelUsage
  /** Readable model that describes this event; see `inheritedModel`. */
  model?: string
  /** The step or generation row this event was read from. */
  owner?: NamedModel
  /** Read from a row this import processes (as opposed to one an earlier import covered). */
  fresh?: boolean
  /** The name was taken from the database's last named generation, which changes as the database grows. */
  namedByLast?: boolean
  ts?: number
  sourceKey: string
  lineOffset: number
}

/** A readable model name together with the numeric model id it was stored next to. */
interface NamedModel {
  model?: string
  modelId?: number
  /**
   * The name came from a table (the numeric-id table, a routing alias,
   * `executor_metadata`) rather than from a name the row stores. A name
   * reached through the row's own `MODEL_PLACEHOLDER_M<n>` counts as stored:
   * the placeholder is the row's exact statement of what it ran, and an id
   * does not determine a variant (real rows store both `gemini-3.7-flash` and
   * `gemini-3.7-flash-safety-le` beside one id), so the plain name is what an
   * id-only event elsewhere should inherit.
   */
  inferred?: boolean
}

interface GenerationMetadata extends NamedModel {
  index: number
  stepIndices: number[]
  events: UsageEvent[]
}

interface StepMetadata extends NamedModel {
  ts?: number
  events: UsageEvent[]
}

// A protobuf varint carries at most 64 bits, which is 10 base-128 bytes.
// Negative int64/int32 values (for example -1 sentinels) always use all 10.
const MAX_VARINT_BYTES = 10

function readVarint(data: Buffer, start: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < data.length && offset - start < MAX_VARINT_BYTES) {
    const byte = data[offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7
  }
  throw new Error('invalid protobuf varint')
}

function readFields(data: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < data.length) {
    const key = readVarint(data, offset)
    const number = Math.floor(key.value / 8)
    const wireType = key.value % 8
    if (number < 1) throw new Error('invalid protobuf field number')
    offset = key.offset

    if (wireType === 0) {
      const parsed = readVarint(data, offset)
      fields.push({ number, wireType, value: parsed.value })
      offset = parsed.offset
    } else if (wireType === 1) {
      if (offset + 8 > data.length) throw new Error('truncated protobuf fixed64')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 8) })
      offset += 8
    } else if (wireType === 2) {
      const size = readVarint(data, offset)
      const end = size.offset + size.value
      if (end > data.length) throw new Error('truncated protobuf bytes')
      fields.push({ number, wireType, value: data.subarray(size.offset, end) })
      offset = end
    } else if (wireType === 5) {
      if (offset + 4 > data.length) throw new Error('truncated protobuf fixed32')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 4) })
      offset += 4
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`)
    }
  }
  return fields
}

function messages(fields: ProtoField[], number: number): ProtoField[][] {
  return fields
    .filter((field) => field.number === number && field.wireType === 2 && Buffer.isBuffer(field.value))
    .map((field) => readFields(field.value as Buffer))
}

function firstMessage(fields: ProtoField[], number: number): ProtoField[] {
  return messages(fields, number)[0] ?? []
}

function firstVarint(fields: ProtoField[], number: number): number | undefined {
  const field = fields.find((candidate) => candidate.number === number && candidate.wireType === 0)
  return field && typeof field.value === 'number' ? field.value : undefined
}

function firstString(fields: ProtoField[], numbers: number[]): string | undefined {
  for (const number of numbers) {
    const field = fields.find((candidate) => candidate.number === number && candidate.wireType === 2)
    if (!field || !Buffer.isBuffer(field.value)) continue
    const value = field.value.toString('utf8').trim()
    if (value) return value
  }
  return undefined
}

function repeatedVarints(fields: ProtoField[], number: number): number[] {
  const values: number[] = []
  for (const field of fields) {
    if (field.number !== number) continue
    if (field.wireType === 0 && typeof field.value === 'number') {
      values.push(field.value)
    } else if (field.wireType === 2 && Buffer.isBuffer(field.value)) {
      let offset = 0
      while (offset < field.value.length) {
        const parsed = readVarint(field.value, offset)
        values.push(parsed.value)
        offset = parsed.offset
      }
    }
  }
  return values
}

function timestampFromFields(fields: ProtoField[]): number | undefined {
  const seconds = firstVarint(fields, 1)
  if (seconds == null || seconds <= 0) return undefined
  const nanos = Math.min(firstVarint(fields, 2) ?? 0, 999_999_999)
  return seconds * 1000 + Math.floor(nanos / 1_000_000)
}

function generationTimestamp(chatModel: ProtoField[]): number | undefined {
  const generationInfo = firstMessage(chatModel, 9)
  return timestampFromFields(firstMessage(generationInfo, 4))
}

const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  'gemini 3.8 flash': 'gemini-3.8-flash',
  'gemini 3.7 flash': 'gemini-3.7-flash',
  'gemini 3.7 flash thinking': 'gemini-3.7-flash',
  'gemini 3.7 pro': 'gemini-3.7-pro',
  'gemini 3.7 pro thinking': 'gemini-3.7-pro',
  'gemini 3.6 flash': 'gemini-3.6-flash',
  'gemini 3 flash': 'gemini-3.6-flash',
  'gemini 3.6 pro': 'gemini-3.6-pro',
  'gemini 3 pro': 'gemini-3-pro',
  'gemini 3 pro thinking': 'gemini-3-pro',
  'gemini 2.5 flash': 'gemini-2.5-flash',
  'gemini 2.5 pro': 'gemini-2.5-pro',
  'gemini 2.0 flash': 'gemini-2.0-flash',
  'gemini 2 flash': 'gemini-2.0-flash',
  'gemini 2.0 pro': 'gemini-2.0-pro',
  'gemini 1.5 flash': 'gemini-1.5-flash',
  'gemini 1.5 pro': 'gemini-1.5-pro',
  'claude opus 4.6': 'claude-opus-4-6',
  'claude 4.6 opus': 'claude-opus-4-6',
  'claude sonnet 4.6': 'claude-sonnet-4-6',
  'claude 4.6 sonnet': 'claude-sonnet-4-6',
  'claude sonnet 4.5': 'claude-sonnet-4-5',
  'claude 3.7 sonnet': 'claude-3-7-sonnet',
  'claude 3.7 sonnet thinking': 'claude-3-7-sonnet',
  'claude 3.5 sonnet': 'claude-3-5-sonnet',
  'claude 3.5 haiku': 'claude-3-5-haiku',
  'claude 3 opus': 'claude-3-opus',
  'gpt-oss 120b': 'gpt-oss-120b-medium',
  'model_openai_gpt_oss_120b_medium': 'gpt-oss-120b-medium',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-4.5-sonnet': 'claude-sonnet-4-5',
  'claude-4.5-haiku': 'claude-haiku-4-5',
  'gemini-3-flash': 'gemini-3-flash-preview',
}

/**
 * Routing names Antigravity uses for "whatever model the default or agent slot
 * points at right now". Their target moves between Antigravity releases, so
 * they are consulted only when a row carries nothing more specific: no known
 * canonical name, no versioned model name, no display label, no known id.
 */
const ANTIGRAVITY_ROUTING_ALIASES: Record<string, string> = {
  'gemini-default': 'gemini-3.5-flash-medium',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-3-flash-agent': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-c': 'gemini-3-flash-preview',
}

/**
 * Antigravity's `MODEL_PLACEHOLDER_M<n>` labels denote the model with numeric
 * id `1000 + n` (true for every pair observed), so placeholders resolve through
 * the numeric-id table and also supply the id when a row stores none.
 */
const PLACEHOLDER_ID_OFFSET = 1000
const PLACEHOLDER_PATTERN = /^model_placeholder_m(\d+)$/i

/**
 * Numeric model ids observed in Antigravity databases. Consulted after a row's
 * own readable model names (see `resolveModel`) and as the fallback for usage
 * events that carry an id but inherit no readable name. Effort-qualified names
 * Antigravity assigns itself (`gemini-3.5-flash-high`, `gemini-3.1-pro-low`)
 * are kept as the model identity; pricing maps them onto one registry entry (#69).
 */
const KNOWN_MODEL_IDS: Record<number, string> = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet',
  290: 'claude-4-opus',
  291: 'claude-4-opus',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b-medium',
  1016: 'gemini-3.1-pro',
  1018: 'gemini-3-flash-preview',
  1020: 'gemini-3.5-flash-medium',
  1026: 'claude-opus-4-6',
  1035: 'claude-sonnet-4-6',
  1036: 'gemini-3.1-pro',
  1037: 'gemini-3.1-pro',
  1047: 'gemini-3-flash-preview',
  1071: 'gemini-3.6-flash',
  1084: 'gemini-3-flash-preview',
  1132: 'gemini-3.5-flash-high',
  1133: 'gemini-3.5-flash-high',
  1187: 'gemini-3.5-flash-extra-low',
  1264: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash',
  1299: 'gemini-3.7-flash',
  1318: 'gemini-3.8-flash',
}

function lookup(table: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

function cleanModel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const model = (value.includes('/') ? value.split('/').pop() : value)?.trim()
  return model || undefined
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value)
}

function placeholderModelId(value: string | undefined): number | undefined {
  const match = value ? PLACEHOLDER_PATTERN.exec(value.trim()) : null
  return match ? PLACEHOLDER_ID_OFFSET + Number(match[1]) : undefined
}

function knownModelName(modelId: number): string | undefined {
  return KNOWN_MODEL_IDS[modelId]
}

/** The canonical model a display label, `(Thinking)` variant or placeholder stands for, if known. */
function canonicalModel(value: string | undefined): string | undefined {
  const model = cleanModel(value)
  if (!model) return undefined
  const key = model.toLowerCase()
  const placeholderId = placeholderModelId(key)
  if (placeholderId != null) return knownModelName(placeholderId)
  const base = key.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return lookup(ANTIGRAVITY_MODEL_ALIASES, key) ?? lookup(ANTIGRAVITY_MODEL_ALIASES, base)
}

function routingAlias(value: string | undefined): string | undefined {
  const model = cleanModel(value)
  return model ? lookup(ANTIGRAVITY_ROUTING_ALIASES, model.toLowerCase()) : undefined
}

/**
 * `Gemini 3.5 Flash (Medium)` → `gemini-3.5-flash`. The parenthetical effort
 * qualifier is dropped because Antigravity's own slug for the same row does not
 * carry it (`gemini-3.6-flash` is labelled `Gemini 3.6 Flash (High)`). Labels
 * of any other shape are left alone.
 */
function geminiLabelSlug(label: string | undefined): string | undefined {
  const match = label ? /^gemini (\d+(?:\.\d+)?)((?: [a-z]+)+?)(?: \([a-z ]+\))?$/.exec(label.trim().toLowerCase()) : null
  if (!match) return undefined
  const [, version, family] = match
  return ['gemini', version, ...family.trim().split(' ')].join('-')
}

/** Routing-slot names Antigravity mints (`gemini-default`, `gemini-pro-agent`, `gemini-3-flash-a`), whatever the current table knows. */
const ROUTING_SLOT_SHAPE = /-(?:default|agent(?:-[a-z])?|[a-z])$/i

/** A machine-readable model name Antigravity assigned (`gemini-3.8-flash`, `gemini-3.8-flash-high`), as opposed to a routing alias or placeholder. */
function isVersionedModelName(value: string): boolean {
  return /\d/.test(value) && !isPlaceholder(value) && routingAlias(value) == null && !ROUTING_SLOT_SHAPE.test(value)
}

const EFFORT_SUFFIX = /-(?:extra-low|low|medium|high)$/

/**
 * Whether `own` names the same model as `identity`, at most more precisely:
 * once effort qualifiers are dropped, the identity's segments prefix the
 * name's. `gemini-3.5-flash-high` refines `gemini-3.5-flash-medium` and
 * `gemini-3.7-flash-safety-le` refines `gemini-3.7-flash`; `gemini-3-flash-d`
 * does not refine `gemini-3.5-flash-high`, and neither does the less specific
 * `gemini-2.5-flash` refine `gemini-2.5-flash-lite`.
 */
function refinesModel(own: string, identity: string): boolean {
  const [ownSegments, identitySegments] = [own, identity]
    .map((name) => name.toLowerCase().replace(EFFORT_SUFFIX, '').split('-'))
  return ownSegments.length >= identitySegments.length
    && identitySegments.every((segment, index) => segment === ownSegments[index])
}

/** A versioned model name of a known provider; gates values whose storage layout is inferred rather than observed. */
function isModelShaped(value: string): boolean {
  return value.length <= 64 && /^[a-z][a-z0-9._-]*$/i.test(value) && inferProvider(value.toLowerCase()) !== 'unknown' && isVersionedModelName(value)
}

interface ModelCandidates {
  modelId?: number
  /** Model slug Antigravity selected (chat model field 19): a versioned name, a routing alias or a placeholder. */
  slug?: string
  /** Executor model embedded in the generation row (field 3 → 28), usually effort-qualified. */
  executor?: string
  /** Executor model from the `executor_metadata` table; its layout is inferred, not observed, so it ranks low. */
  tableExecutor?: string
  /** `MODEL_PLACEHOLDER_M<n>` from the chat model's `model_enum` entry (field 20). */
  placeholder?: string
  /** Display label such as `Gemini 3.8 Flash (High)` (field 21). */
  label?: string
}

/**
 * Names a row (a generation, or a step) from the metadata Antigravity stores
 * with it. The row's identity is the placeholder as an exact id reference
 * (`MODEL_PLACEHOLDER_M<n>` through the id table), else the display label
 * (canonical, or slugified: `Gemini 3.8 Flash (High)` → `gemini-3.8-flash`),
 * else the known numeric-id table. Precedence:
 *  1. the slug — canonical when it maps to a known model (`(Thinking)`
 *     variants, name normalisations), else verbatim when it is a versioned
 *     model name Antigravity assigned (`gemini-3.8-flash`,
 *     `gemini-3.5-flash-high`) — when it agrees with the row's identity, so
 *     it refines the identity with an effort or variant qualifier but never
 *     contradicts it: Antigravity also mints routing-slot names that look
 *     versioned (`gemini-3-flash-d`), and not all of them are in the routing
 *     table;
 *  2. the row's identity from the placeholder or the label;
 *  3. the known numeric-id table — which also means that a slug on a row
 *     whose only identity is a known id defers to the table, so an entry that
 *     is wrong (rather than merely missing) would be sticky for such rows;
 *  4. the executor model, canonical or verbatim when versioned
 *     (`gemini-3.8-flash-high`) — it names the executor, which is not always
 *     the row's own model, so it never outranks the row's slug, label or id;
 *  5. a routing alias (`gemini-default`), whose target moves between releases;
 *  6. the `executor_metadata` table's value when it is model-shaped;
 *  7. any remaining readable name verbatim (never a bare placeholder).
 * A numeric id nobody knows never displaces a readable name; the caller falls
 * back to `antigravity-model-<id>` only when nothing readable exists (#68).
 * The result is flagged `inferred` when the name came from a table (3, 5, 6)
 * rather than from a name the row stores.
 */
function resolveModel(candidates: ModelCandidates): Pick<NamedModel, 'model' | 'inferred'> {
  const { modelId } = candidates
  // A placeholder that contradicts the row's id (explicit, or derived from a
  // higher-ranked placeholder) never names the row: it would attach the other
  // id's model to usage stamped with this one. The two agreed on every row observed.
  const consistent = (name: string | undefined): string | undefined => {
    const placeholderId = placeholderModelId(name)
    return placeholderId != null && modelId != null && placeholderId !== modelId ? undefined : name
  }
  const placeholder = consistent(candidates.placeholder)
  const label = consistent(candidates.label)
  const slug = consistent(cleanModel(candidates.slug))
  const executor = consistent(cleanModel(candidates.executor))
  const tableExecutor = cleanModel(candidates.tableExecutor)
  const versioned = (name: string | undefined): string | undefined => name && isVersionedModelName(name) ? name : undefined
  const stored = (model: string | undefined): Pick<NamedModel, 'model' | 'inferred'> | undefined => model ? { model, inferred: false } : undefined
  const inferred = (model: string | undefined): Pick<NamedModel, 'model' | 'inferred'> | undefined => model ? { model, inferred: true } : undefined
  const own = canonicalModel(slug) ?? versioned(slug)
  const stated = canonicalModel(placeholder) ?? canonicalModel(label) ?? geminiLabelSlug(label)
  const known = modelId != null ? knownModelName(modelId) : undefined
  const identity = stated ?? known
  return (own && (identity == null || refinesModel(own, identity)) ? stored(own) : undefined)
    ?? stored(stated)
    ?? inferred(known)
    ?? stored(canonicalModel(executor) ?? versioned(executor))
    ?? inferred([slug, executor].map(routingAlias).find(Boolean))
    ?? inferred(tableExecutor && isModelShaped(tableExecutor) ? tableExecutor : undefined)
    ?? stored([slug, executor, cleanModel(label)].find((name): name is string => name != null && !isPlaceholder(name)))
    ?? { model: undefined, inferred: false }
}

/** The readable model of `named` when it can describe an event with `modelId`: the ids match, or either side has none. */
function describedBy(named: NamedModel | undefined, modelId: number | undefined): string | undefined {
  if (!named?.model) return undefined
  return modelId == null || named.modelId == null || named.modelId === modelId ? named.model : undefined
}

/**
 * The readable model an event with `modelId` inherits, if any: first its owner
 * (the step or generation row it was read from) or a surrounding generation
 * (the current one, then the last named one) whose id equals the event's;
 * then a name that rows elsewhere in this database pair with the event's id;
 * then the known-id table; then the owner alone when it carries no id, since
 * a row can only be assumed to agree with the usage stored inside it. An
 * event without an id takes the first readable name among owner and context.
 * A row with a different id, or a surrounding generation with none, never
 * lends its name — Antigravity's helper model runs inside conversations
 * driven by another model (#68).
 */
function inheritedModel(modelId: number | undefined, owner: NamedModel | undefined, context: Array<NamedModel | undefined>, learned: ReadonlyMap<number, string>): string | undefined {
  const rows = [owner, ...context]
  if (modelId == null) return rows.find((row) => row?.model)?.model
  const exact = rows.find((row) => row?.model && row.modelId === modelId)
  if (exact) return exact.model
  return learned.get(modelId) ?? knownModelName(modelId) ?? describedBy(owner, modelId)
}

function modelEnum(chatModel: ProtoField[]): string | undefined {
  for (const entry of messages(chatModel, 20)) {
    if (firstString(entry, [1]) === 'model_enum') return firstString(entry, [2])
  }
  return undefined
}

function parseModelUsage(fields: ProtoField[]): ModelUsage {
  const totalOutputTokens = firstVarint(fields, 3) ?? 0
  const thinkingTokens = firstVarint(fields, 9) ?? 0
  const visibleOutputTokens = firstVarint(fields, 10) ?? 0
  const normalizedTotalOutput = Math.max(totalOutputTokens, visibleOutputTokens + thinkingTokens)
  const responseId = firstString(fields, [11])
  const providerMessageId = firstString(fields, [12])
  const messageId = firstString(fields, [7])
  return {
    modelId: firstVarint(fields, 1) || undefined,
    inputTokens: firstVarint(fields, 2) ?? 0,
    totalOutputTokens: normalizedTotalOutput,
    cacheWriteTokens: firstVarint(fields, 4) ?? 0,
    cacheReadTokens: firstVarint(fields, 5) ?? 0,
    thinkingTokens,
    outputTokens: Math.max(visibleOutputTokens, normalizedTotalOutput - thinkingTokens),
    identities: [
      responseId ? `response:${responseId}` : undefined,
      providerMessageId ? `provider:${providerMessageId}` : undefined,
      messageId ? `message:${messageId}` : undefined,
    ].filter((value): value is string => Boolean(value)),
  }
}

function tokenBearing(usage: ModelUsage): boolean {
  return usage.inputTokens + usage.totalOutputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > 0
}

function usageEvents(fields: ProtoField[], usageField: number, retryField: number, source: string, lineOffset: number, ts?: number): UsageEvent[] {
  const events: UsageEvent[] = []
  const usage = messages(fields, usageField)[0]
  if (usage) events.push({ usage: parseModelUsage(usage), ts, sourceKey: `${source}:usage`, lineOffset })
  for (const [index, retry] of messages(fields, retryField).entries()) {
    const retryUsage = messages(retry, 2)[0]
    if (retryUsage) events.push({ usage: parseModelUsage(retryUsage), ts, sourceKey: `${source}:retry:${index}`, lineOffset })
  }
  return events.filter((event) => tokenBearing(event.usage))
}

function parseGeneration(index: number, data: Buffer, tableExecutor?: string): GenerationMetadata {
  const metadata = readFields(data)
  const chatModel = firstMessage(metadata, 1)
  const slug = firstString(chatModel, [19])
  const placeholder = modelEnum(chatModel)
  const modelId = (firstVarint(chatModel, 3) || undefined) ?? placeholderModelId(placeholder) ?? placeholderModelId(slug)
  const ts = generationTimestamp(chatModel)
  const generation: GenerationMetadata = {
    index,
    modelId,
    ...resolveModel({
      modelId,
      slug,
      executor: firstString(firstMessage(metadata, 3), [28]),
      tableExecutor,
      placeholder,
      label: firstString(chatModel, [21, 22]),
    }),
    stepIndices: repeatedVarints(metadata, 2),
    events: [],
  }
  // A usage row stored inside the chat model belongs to that model; give it
  // the generation's id when it carries none (a placeholder-derived id too).
  generation.events = usageEvents(chatModel, 4, 17, `generation:${index}`, index, ts).map((event) => {
    event.usage.modelId ??= modelId
    return { ...event, owner: generation }
  })
  return generation
}

function parseStep(index: number, data: Buffer): StepMetadata {
  const metadata = readFields(data)
  const modelInfo = firstMessage(metadata, 24)
  const slug = firstString(modelInfo, [12])
  const label = firstString(modelInfo, [8])
  const modelId = (firstVarint(modelInfo, 1) || undefined) ?? placeholderModelId(slug) ?? placeholderModelId(label)
  const ts = timestampFromFields(firstMessage(metadata, 8))
    ?? timestampFromFields(firstMessage(metadata, 1))
  const step: StepMetadata = {
    ts,
    modelId,
    ...resolveModel({ modelId, slug, label }),
    events: [],
  }
  step.events = usageEvents(metadata, 9, 28, `step:${index}`, index, ts).map((event) => {
    event.usage.modelId ??= modelId
    return { ...event, owner: step }
  })
  return step
}

/** The model an event is billed to: its inherited readable name, else the known-id table, else a placeholder. */
function modelForEvent(event: UsageEvent): string {
  if (event.model) return event.model
  const modelId = event.usage.modelId
  if (modelId == null) return 'antigravity-unknown'
  return knownModelName(modelId) ?? `antigravity-model-${modelId}`
}

function mergeIdentities(target: UsageEvent, duplicate: UsageEvent): void {
  target.usage.identities = [...new Set([...target.usage.identities, ...duplicate.usage.identities])]
}

/**
 * Folds a second copy of the same response into `target`. Copies that agree on
 * the model id (or where one carries none) merge field by field; when the
 * merged event has an id, only a readable name paired with that id is kept —
 * a name an id-less copy inherited from its surroundings would attach another
 * id's model — and only when neither copy has an id does any name do.
 * Copies that disagree on the id (a step copy on the helper model, the
 * generation copy on the conversation's model) cannot both be right and
 * nothing in the database says which is: the copy seen first is kept whole,
 * and the other contributes only its identities, so neither its name nor its
 * token counts are billed to the first copy's model (#68).
 */
function mergeEvent(target: UsageEvent, duplicate: UsageEvent): void {
  const targetId = target.usage.modelId
  const duplicateId = duplicate.usage.modelId
  target.fresh = target.fresh || duplicate.fresh
  if (targetId != null && duplicateId != null && targetId !== duplicateId) {
    mergeIdentities(target, duplicate)
    return
  }
  target.namedByLast = target.namedByLast || duplicate.namedByLast
  const modelId = targetId ?? duplicateId
  const copies: NamedModel[] = [
    { model: target.model, modelId: targetId },
    { model: duplicate.model, modelId: duplicateId },
  ]
  target.model = modelId == null
    ? copies.find((copy) => copy.model)?.model
    : copies.find((copy) => copy.model && copy.modelId === modelId)?.model
  target.usage.modelId = modelId
  target.usage.inputTokens = Math.max(target.usage.inputTokens, duplicate.usage.inputTokens)
  target.usage.totalOutputTokens = Math.max(target.usage.totalOutputTokens, duplicate.usage.totalOutputTokens)
  target.usage.cacheWriteTokens = Math.max(target.usage.cacheWriteTokens, duplicate.usage.cacheWriteTokens)
  target.usage.cacheReadTokens = Math.max(target.usage.cacheReadTokens, duplicate.usage.cacheReadTokens)
  target.usage.thinkingTokens = Math.max(target.usage.thinkingTokens, duplicate.usage.thinkingTokens)
  target.usage.outputTokens = Math.max(target.usage.outputTokens, duplicate.usage.outputTokens)
  mergeIdentities(target, duplicate)
  target.ts = target.ts == null ? duplicate.ts : duplicate.ts == null ? target.ts : Math.min(target.ts, duplicate.ts)
  if (duplicate.sourceKey < target.sourceKey) target.sourceKey = duplicate.sourceKey
  target.lineOffset = Math.min(target.lineOffset, duplicate.lineOffset)
}

function deduplicateEvents(events: UsageEvent[]): UsageEvent[] {
  const slots: Array<UsageEvent | undefined> = []
  const identitySlots = new Map<string, number>()
  for (const event of events) {
    const matches = [...new Set(event.usage.identities
      .map((identity) => identitySlots.get(identity))
      .filter((value): value is number => value != null))]
    const targetIndex = matches[0] ?? slots.length
    if (matches.length === 0) slots.push(event)
    else mergeEvent(slots[targetIndex]!, event)
    for (const duplicateIndex of matches.slice(1)) {
      if (slots[duplicateIndex]) {
        mergeEvent(slots[targetIndex]!, slots[duplicateIndex]!)
        slots[duplicateIndex] = undefined
      }
    }
    for (const identity of slots[targetIndex]!.usage.identities) identitySlots.set(identity, targetIndex)
  }
  return slots.filter((event): event is UsageEvent => event != null)
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) != null
}

/**
 * Executor model per generation index from the optional `executor_metadata`
 * table (field 28). Current databases embed the same value in the generation
 * row itself; this table is consulted only for generations that lack it.
 */
function readExecutorModels(db: Database.Database): Map<number, string> {
  const models = new Map<number, string>()
  if (!hasTable(db, 'executor_metadata')) return models
  let rows: Array<{ idx: number; data: unknown }>
  try {
    rows = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx').all() as Array<{ idx: number; data: unknown }>
  } catch {
    return models
  }
  for (const row of rows) {
    if (!Buffer.isBuffer(row.data)) continue
    try {
      const model = firstString(readFields(row.data), [28])
      if (model) models.set(Number(row.idx), model)
    } catch {
      // Auxiliary hint only: an unreadable executor row never fails the import.
    }
  }
  return models
}

function readTrajectoryTimestamp(db: Database.Database, errors: string[]): number | undefined {
  try {
    if (!hasTable(db, 'trajectory_metadata_blob')) return undefined
    const rows = db.prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid').all() as Array<{ data: unknown }>
    let timestamp: number | undefined
    for (const [index, row] of rows.entries()) {
      try {
        if (!Buffer.isBuffer(row.data)) throw new Error('trajectory metadata is not a blob')
        const candidate = timestampFromFields(firstMessage(readFields(row.data), 2))
        timestamp ??= candidate
      } catch (error) {
        errors.push(`trajectory metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return timestamp
  } catch (error) {
    errors.push(`trajectory metadata: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

export function runParseAntigravity(db: Database.Database, options: AntigravityImportOptions): AntigravityImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, fallbackTs, startIndex, exchangeRate } = options
  const errors: string[] = []
  const firstIndex = Math.max(0, startIndex)
  let nextIndex = firstIndex

  if (!hasTable(db, 'gen_metadata')) {
    return { records: [], nextIndex, errors: ['conversation database does not contain gen_metadata table'] }
  }

  const trajectoryTs = readTrajectoryTimestamp(db, errors)
  const executorModels = readExecutorModels(db)
  const generations: GenerationMetadata[] = []
  const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data: Buffer }>
  for (const row of rows) {
    const index = Number(row.idx)
    try {
      if (!Buffer.isBuffer(row.data)) throw new Error('generation metadata is not a blob')
      generations.push(parseGeneration(index, row.data, executorModels.get(index)))
    } catch (error) {
      if (index >= firstIndex) {
        errors.push(`generation metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  const importedStep = Math.max(-1, ...generations
    .filter((generation) => generation.index < firstIndex)
    .flatMap((generation) => generation.stepIndices))
  // Every step is parsed, including those an earlier import already covered:
  // the names they pair with model ids below must not depend on the cursor,
  // or an incremental import would attribute usage differently from a full one.
  const steps = new Map<number, StepMetadata>()
  if (hasTable(db, 'steps')) {
    const stepRows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').all() as Array<{ idx: number; metadata: Buffer }>
    for (const row of stepRows) {
      const index = Number(row.idx)
      if (!Buffer.isBuffer(row.metadata)) continue
      try {
        steps.set(index, parseStep(index, row.metadata))
      } catch (error) {
        if (index > importedStep) errors.push(`step metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  // The conversation's structure — the steps each generation's window covers —
  // is fixed before any name is resolved and never depends on the import
  // cursor: every generation is walked exactly as a full import walks it.
  // The window boundary only ever advances, so a step belongs to exactly one
  // window even when a generation links a lower step index than its
  // predecessor (its linked steps then sit in an earlier window).
  interface Window { generation: GenerationMetadata; stepIndices: number[]; linkedTs?: number }
  const windows: Window[] = []
  let previousStep = -1
  for (const generation of generations) {
    const lastStep = Math.max(previousStep, ...generation.stepIndices)
    windows.push({
      generation,
      stepIndices: [...steps.keys()].filter((index) => index > previousStep && index <= lastStep),
      linkedTs: generation.stepIndices.map((index) => steps.get(index)?.ts).find((ts) => ts != null),
    })
    previousStep = lastStep
  }
  // The latest generation is still being written while it carries no usage,
  // in its own row, in the steps its window covers or in the steps it links
  // (one of which an earlier window may cover): it is left for a later
  // import, and so that a full import agrees with the one that imports it
  // later, neither it nor the steps it covers name anything yet.
  const latest = windows[windows.length - 1]
  const hasUsage = (window: Window): boolean => window.generation.events.length > 0
    || [...window.stepIndices, ...window.generation.stepIndices].some((index) => (steps.get(index)?.events.length ?? 0) > 0)
  const settled = latest != null && !hasUsage(latest) ? windows.slice(0, -1) : windows

  // Numeric ids this database pairs with readable names: an event whose id is
  // named only elsewhere in the database (a helper model, a retry on another
  // model) is named from those rows rather than from the hard-coded table.
  // Names a row stores beside its id are learned before names a row took from
  // a table, each in row order, so an id is attributed to the first row that
  // named it — the same row whether the import is full or incremental. A row
  // named only from a table then takes the name another row stores beside
  // the same id. (Rows that store different names beside one id, such as a
  // variant slug next to a plain one, keep their own names.)
  interface ParsedRow { named: NamedModel; kind: 'generation' | 'step'; index: number }
  const parsedRows: ParsedRow[] = [
    ...settled.map((window): ParsedRow => ({ named: window.generation, kind: 'generation', index: window.generation.index })),
    ...settled.flatMap((window) => window.stepIndices.map((index): ParsedRow => ({ named: steps.get(index)!, kind: 'step', index }))),
  ]
  const learned = new Map<number, string>()
  const namedBy = new Map<number, ParsedRow>()
  const learn = (row: ParsedRow): void => {
    const { modelId, model } = row.named
    if (modelId == null || !model || learned.has(modelId)) return
    learned.set(modelId, model)
    namedBy.set(modelId, row)
  }
  for (const stored of [true, false]) {
    for (const row of parsedRows) if (!row.named.inferred === stored) learn(row)
  }
  for (const row of parsedRows) if (row.named.inferred && row.named.modelId != null) row.named.model = learned.get(row.named.modelId) ?? row.named.model

  // Rows this import processes: the generations from the cursor on, the steps
  // their windows cover, and the steps they link — a step written for a new
  // generation falls into an earlier generation's window when the new one
  // links lower step indices than its predecessor, and a full import records
  // it there.
  const processedGenerations = settled.filter((window) => window.generation.index >= firstIndex)
  const processedSteps = new Set(processedGenerations.flatMap((window) => [...window.stepIndices, ...window.generation.stepIndices]))
  const lastProcessed = processedGenerations[processedGenerations.length - 1]
  if (lastProcessed) nextIndex = lastProcessed.generation.index + 1

  // Events are named as a full import names them. Those read from rows this
  // import processes are marked fresh; the rest are emitted only when this
  // import changes what a full import would record for them (see `touched`
  // below). Record ids do not depend on the model, so re-emitted rows replace
  // the earlier ones in place and an incremental import ends where a full
  // import would.
  const lastNamed = [...settled].reverse().find((window) => window.generation.model)?.generation
  // The generation an event is named after when its own row does not name
  // it: the last named generation at or before the one whose window covers
  // it — or, for a step some generation links explicitly, at or before that
  // generation, since a step linked by a later generation sits in an earlier
  // window (see above).
  const currentAt = new Map<number, NamedModel | undefined>()
  const linkedBy = new Map<number, GenerationMetadata>()
  let current: NamedModel | undefined
  for (const { generation } of settled) {
    if (generation.model) current = generation
    currentAt.set(generation.index, current)
    for (const index of generation.stepIndices) if (!linkedBy.has(index)) linkedBy.set(index, generation)
  }
  const events: UsageEvent[] = []
  for (const { generation, stepIndices, linkedTs } of settled) {
    const rowEvents: Array<[UsageEvent, NamedModel | undefined]> = [
      ...stepIndices.flatMap((index) => steps.get(index)!.events.map((event): [UsageEvent, NamedModel | undefined] =>
        [{ ...event, fresh: processedSteps.has(index) }, currentAt.get((linkedBy.get(index) ?? generation).index)])),
      ...generation.events.map((event): [UsageEvent, NamedModel | undefined] =>
        [{ ...event, ts: event.ts ?? linkedTs, fresh: generation.index >= firstIndex }, currentAt.get(generation.index)]),
    ]
    for (const [event, context] of rowEvents) {
      event.model = inheritedModel(event.usage.modelId, event.owner, [context, lastNamed], learned)
      event.namedByLast = event.model != null && inheritedModel(event.usage.modelId, event.owner, [context], learned) !== event.model
      events.push(event)
    }
  }

  // Ids first named by a row this import processed. Usage imported earlier
  // under such an id was recorded as antigravity-model-<id> or under the id
  // table's name, and a full import would name it from that row; a name the
  // id table already gave is nothing new.
  const processedNow = (row: ParsedRow): boolean => row.kind === 'generation' ? row.index >= firstIndex : processedSteps.has(row.index)
  const newlyNamed = new Set([...namedBy]
    .filter(([modelId, row]) => processedNow(row) && learned.get(modelId) !== knownModelName(modelId))
    .map(([modelId]) => modelId))
  const lastNamedNow = lastNamed != null && lastNamed.index >= firstIndex
  // A record is written when a row this import processed contributes to it
  // (including a new copy of a response an earlier import recorded, which is
  // merged with the earlier copies exactly as a full import merges them), when
  // a row this import processed first named its id, or when it took its name
  // from the database's last named generation and that generation is one this
  // import processed.
  const touched = (event: UsageEvent): boolean => event.fresh === true
    || (event.usage.modelId != null && newlyNamed.has(event.usage.modelId))
    || (event.namedByLast === true && lastNamedNow)

  const sessionId = basename(dbPath).replace(/\.db$/i, '') || 'unknown'
  const records = deduplicateEvents(events).filter(touched).map((event): StatsRecord => {
    const model = modelForEvent(event)
    const provider = inferProvider(model)
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens } = event.usage
    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens }
    const hasPrice = resolvePrice(model) != null
    const identity = [...event.usage.identities].sort()[0] ?? event.sourceKey
    return {
      id: recordIdFor(options, `antigravity:${sessionId}:${identity}`, 0),
      // The row index, not the position in this import's output, keeps the
      // fallback the same whether the record is imported in full or in part.
      ts: event.ts ?? trajectoryTs ?? fallbackTs + event.lineOffset,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: event.lineOffset,
      tool: 'antigravity',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost: hasPrice ? calculateCost(model, tokenArgs, exchangeRate) : 0,
      costSource: hasPrice ? 'pricing' : 'unknown',
      sessionId,
      sourceFile: dbPath,
      device,
      deviceInstanceId,
      platform,
    }
  })

  return { records, nextIndex, errors }
}
