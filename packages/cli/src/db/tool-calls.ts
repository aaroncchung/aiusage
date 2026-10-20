import type Database from 'better-sqlite3'
import type { ToolCallRecord } from '@aiusage/core'
import { generateBlockToolCallId, generateToolCallId } from '@aiusage/core'

export function insertToolCall(db: Database.Database, tc: ToolCallRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_calls (id, record_id, tool, name, ts, call_index)
    VALUES (@id, @recordId, @tool, @name, @ts, @callIndex)
  `).run({
    id: tc.id,
    recordId: tc.recordId ?? null,
    tool: tc.recordId ? null : (tc as any).tool,
    name: tc.name,
    ts: tc.ts,
    callIndex: tc.callIndex,
  })
}

/** The columns a positional tool-call id is built from. */
export interface ToolCallIdRow {
  id: string
  record_id: string
  name: string
  ts: number
  call_index: number
}

/**
 * True when a tool call's id is the hash of its own record id, name,
 * timestamp and call index: the scheme every Claude Code tool call used
 * before ids were keyed on the `tool_use` block. The Claude Code parser no
 * longer produces such an id, and the row carries everything that hash was
 * built from, so no flag is needed to recognise a row an earlier release wrote.
 */
export function hasPositionalToolCallId(row: ToolCallIdRow): boolean {
  return row.id === generateToolCallId(row.record_id, row.name, row.ts, row.call_index)
}

/**
 * Delete the row an earlier release stored for the same call as `tc` under a
 * positional id. `tc` is a Claude Code call that is about to be written under
 * its block-keyed id, and `insertToolCall` only replaces a row with the same
 * id, so the old row would count the call twice.
 *
 * Only the row of this very call is removed: its id is rebuilt from the
 * call's own record id, name, timestamp and index. Positional rows of the
 * record that the log being read does not contain are left alone: they may
 * come from a transcript that no longer exists. Two blocks of one message
 * that share name, timestamp and index shared one positional id, so at most
 * one row ever stood for both; each of them replaces it.
 *
 * A Skill call may have been stored as `Skill` (before skill names were read)
 * or `skill__unknown` (before every field holding the name was read). A row
 * under one of those names is the same call only when it was written from the
 * very line `tc` comes from; another Skill block of the message can sit at
 * the same timestamp and index in a transcript that is gone. The caller says
 * so with `fromStoredLine`; without it only the call's own name is matched.
 * Returns the number of rows deleted.
 */
export function deletePositionalCounterpart(db: Database.Database, tc: ToolCallRecord, fromStoredLine = false): number {
  if (!tc.recordId) return 0
  const names = fromStoredLine && tc.name.startsWith('skill__') ? [tc.name, 'Skill', 'skill__unknown'] : [tc.name]
  const remove = db.prepare('DELETE FROM tool_calls WHERE id = ? AND record_id = ?')
  let deleted = 0
  for (const name of new Set(names)) {
    const id = generateToolCallId(tc.recordId, name, tc.ts, tc.callIndex)
    deleted += remove.run(id, tc.recordId).changes
  }
  return deleted
}

/**
 * Delete the call that `tc`'s record adopted from its copy for the same
 * `tool_use` block. `foldRecordCopy` keeps a Claude Code copy's calls under
 * the original record, still under ids built from the copy's id (`copy`, see
 * `RereadRecordIds.copyOf`); `tc`, read from line `lineOffset` of
 * `sourceFile`, writes that block under the record's own id, so the adopted
 * row would count the call twice.
 *
 * A copy written before calls were keyed on their block (v1.5.22) holds the
 * calls of the line it was stored from under positional ids. Another block
 * of the message can share a call's name, timestamp and index, so such a row
 * is this call only when `tc` comes from that very line and the copy was not
 * written from it again since under block-keyed ids (after which a
 * positional row was kept from somewhere else): the rules
 * `deletePositionalCounterpart` follows for the record's own rows. Returns
 * the number of rows deleted.
 */
export function deleteAdoptedToolCall(
  db: Database.Database,
  tc: ToolCallRecord,
  copy: { id: string; sourceFile?: string; lineOffset?: number } | undefined,
  sourceFile: string,
  lineOffset: number,
): number {
  if (!tc.recordId || !copy || !tc.blockKey) return 0
  const blockKeyed = generateBlockToolCallId(copy.id, tc.blockKey)
  const writtenByBlock = db.prepare('SELECT 1 FROM tool_calls WHERE id = ? AND record_id = ?').get(blockKeyed, tc.recordId) !== undefined
  const remove = db.prepare('DELETE FROM tool_calls WHERE id = ? AND record_id = ?')
  let deleted = remove.run(blockKeyed, tc.recordId).changes
  if (!writtenByBlock && copy.sourceFile === sourceFile && copy.lineOffset === lineOffset) {
    const names = tc.name.startsWith('skill__') ? [tc.name, 'Skill', 'skill__unknown'] : [tc.name]
    for (const name of new Set(names)) {
      deleted += remove.run(generateToolCallId(copy.id, name, tc.ts, tc.callIndex), tc.recordId).changes
    }
  }
  return deleted
}

export function getToolCallsByRecordId(db: Database.Database, recordId: string | null): ToolCallRecord[] {
  const rows = recordId === null
    ? db.prepare('SELECT * FROM tool_calls WHERE record_id IS NULL').all() as any[]
    : db.prepare('SELECT * FROM tool_calls WHERE record_id = ?').all(recordId) as any[]

  return rows.map(mapRowToToolCall)
}

export function getToolCallStats(db: Database.Database): Array<{ name: string; count: number }> {
  return db.prepare(`
    SELECT name, COUNT(*) as count
    FROM tool_calls
    GROUP BY name
    ORDER BY count DESC
  `).all() as Array<{ name: string; count: number }>
}

export function deleteOrphanToolCalls(db: Database.Database, beforeTs: number): number {
  const result = db.prepare(
    'DELETE FROM tool_calls WHERE record_id IS NULL AND ts < ?'
  ).run(beforeTs)
  return result.changes
}

function mapRowToToolCall(row: any): ToolCallRecord {
  return {
    id: row.id,
    recordId: row.record_id,
    name: row.name,
    ts: row.ts,
    callIndex: row.call_index,
  }
}
