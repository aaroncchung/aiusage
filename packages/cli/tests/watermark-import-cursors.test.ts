import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatermarkManager } from '../src/watermark.js'

describe('WatermarkManager import cursors', () => {
  let dir: string
  let watermarkPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-wm-cursors-'))
    watermarkPath = join(dir, 'watermark.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const current = {
    grokParserVersion: 1,
    codebuddyParserVersion: 1,
    antigravityParserVersion: 2,
    codefuseParserVersion: 3,
    claudeCodeParserVersion: 2,
  }
  const openCodeCursor = { lastMessageCreatedAt: 3000, lastMessageId: 'oc_2' }

  it('keeps a Kilo cursor that is separate from the OpenCode cursor', () => {
    const wm = new WatermarkManager(watermarkPath)
    expect(wm.getKiloCursor()).toBeNull()

    wm.setOpenCodeCursor(openCodeCursor)
    wm.setKiloCursor({ lastMessageCreatedAt: 2000, lastMessageId: 'kilo_1' })
    wm.save()

    const reloaded = new WatermarkManager(watermarkPath)
    expect(reloaded.getKiloCursor()).toEqual({ lastMessageCreatedAt: 2000, lastMessageId: 'kilo_1' })
    expect(reloaded.getOpenCodeCursor()).toEqual(openCodeCursor)
  })

  it('starts Kilo from the beginning and resets the OpenCode cursor once for an older watermark', () => {
    const entry = { offset: 200, size: 200, mtime: 2 }
    writeFileSync(watermarkPath, JSON.stringify({
      ...current,
      files: { 'claude-code': { '/claude/a.jsonl': entry } },
      opencode: openCodeCursor,
      hermes: { lastEndedAt: 5, lastId: 'h' },
      cursor: { lastCreatedAt: 7, lastId: 'c' },
    }), 'utf-8')

    const wm = new WatermarkManager(watermarkPath)

    // The cursor both imports shared: neither database is trusted to have
    // been read up to it.
    expect(wm.getOpenCodeCursor()).toBeNull()
    expect(wm.getKiloCursor()).toBeNull()
    // Nothing else is reset.
    expect(wm.getEntry('claude-code', '/claude/a.jsonl')).toEqual(entry)
    expect(wm.getHermesCursor()).toEqual({ lastEndedAt: 5, lastId: 'h' })
    expect(wm.getCursorCursor()).toEqual({ lastCreatedAt: 7, lastId: 'c' })

    wm.setOpenCodeCursor(openCodeCursor)
    wm.save()
    expect(JSON.parse(readFileSync(watermarkPath, 'utf-8')).opencodeParserVersion).toBe(1)
    expect(new WatermarkManager(watermarkPath).getOpenCodeCursor()).toEqual(openCodeCursor)
  })

  it('round-trips the open Hermes sessions and the pending OpenCode and Kilo messages', () => {
    const wm = new WatermarkManager(watermarkPath)
    wm.setHermesCursor({ lastEndedAt: 30, lastId: 'fast', openSessionIds: ['slow'] })
    wm.setOpenCodeCursor({ ...openCodeCursor, pendingMessageIds: ['oc_1'] })
    wm.setKiloCursor({ lastMessageCreatedAt: 2000, lastMessageId: 'kilo_2', pendingMessageIds: ['kilo_1'] })
    wm.save()

    const reloaded = new WatermarkManager(watermarkPath)
    expect(reloaded.getHermesCursor()).toEqual({ lastEndedAt: 30, lastId: 'fast', openSessionIds: ['slow'] })
    expect(reloaded.getOpenCodeCursor()).toEqual({ ...openCodeCursor, pendingMessageIds: ['oc_1'] })
    expect(reloaded.getKiloCursor()).toEqual({ lastMessageCreatedAt: 2000, lastMessageId: 'kilo_2', pendingMessageIds: ['kilo_1'] })
  })
})
