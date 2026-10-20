// The date options of `summary` and `export` (#99) resolve to the same local
// calendar-day bounds as the dashboard's date ranges. Each describe block pins
// a non-UTC time zone so the assertions hold regardless of the machine's TZ.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DateOptionError, resolveDateBounds } from '../../src/commands/date-options.js'
import { getDateRangeBounds } from '../../src/api/server.js'

function useTimeZone(tz: string) {
  let original: string | undefined
  beforeAll(() => {
    original = process.env.TZ
    process.env.TZ = tz
  })
  afterAll(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
}

const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime()

describe('resolveDateBounds: --from / --to', () => {
  useTimeZone('America/New_York')

  it('covers whole local days, both ends included, as the dashboard custom range does', () => {
    const bounds = resolveDateBounds({ from: '2026-10-15', to: '2026-10-16' })
    expect(bounds).toEqual({ startTs: local(2026, 10, 15), endTs: local(2026, 10, 17) })
    const dashboard = getDateRangeBounds(null, '2026-10-15', '2026-10-16')
    expect(bounds).toEqual({ startTs: dashboard.start, endTs: dashboard.end })
  })

  it('takes --from or --to alone, leaving the other side open', () => {
    expect(resolveDateBounds({ from: '2026-10-15' })).toEqual({ startTs: local(2026, 10, 15), endTs: undefined })
    expect(resolveDateBounds({ to: '2026-10-15' })).toEqual({ startTs: undefined, endTs: local(2026, 10, 16) })
    expect(resolveDateBounds({ from: '2026-10-15', to: '2026-10-15' }))
      .toEqual({ startTs: local(2026, 10, 15), endTs: local(2026, 10, 16) })
  })

  it('leaves both sides open without options', () => {
    expect(resolveDateBounds({})).toEqual({ startTs: undefined, endTs: undefined })
  })

  it('rejects anything but a real YYYY-MM-DD date, naming the option', () => {
    for (const value of ['2026-02-29', '2026-13-01', '2026-10-32', '2026-00-10', '2026/10/15', '15-10-2026', '2026-1-5', '2026-10-15T00:00', 'today', '']) {
      expect(() => resolveDateBounds({ from: value })).toThrow(new DateOptionError(`Invalid --from date: ${value}. Use YYYY-MM-DD.`))
      expect(() => resolveDateBounds({ to: value })).toThrow(new DateOptionError(`Invalid --to date: ${value}. Use YYYY-MM-DD.`))
    }
    expect(resolveDateBounds({ from: '2028-02-29' }).startTs).toBe(local(2028, 2, 29))
  })

  it('rejects --from after --to', () => {
    expect(() => resolveDateBounds({ from: '2026-10-16', to: '2026-10-15' }))
      .toThrow(new DateOptionError('--from 2026-10-16 is after --to 2026-10-15.'))
  })
})

describe('resolveDateBounds: a day where DST skips midnight', () => {
  // Chile moves its clocks from 00:00 to 01:00 on 2026-09-06.
  useTimeZone('America/Santiago')

  it('ends at the next local midnight, not an hour into the next day', () => {
    const { startTs, endTs } = resolveDateBounds({ from: '2026-09-06', to: '2026-09-06' })
    expect(new Date(startTs!).getHours()).toBe(1)
    expect(new Date(endTs!).getDate()).toBe(7)
    expect(new Date(endTs!).getHours()).toBe(0)
    expect(endTs! - startTs!).toBe(23 * 3600_000)
  })
})

describe('resolveDateBounds: --week / --month / --range', () => {
  useTimeZone('America/New_York')

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts where the dashboard preset starts and has no end', () => {
    // Tuesday 2026-10-20, 09:00 local.
    vi.useFakeTimers({ now: new Date(2026, 9, 20, 9), toFake: ['Date'] })
    expect(resolveDateBounds({ range: 'day' })).toEqual({ startTs: local(2026, 10, 20) })
    expect(resolveDateBounds({ range: 'week' })).toEqual({ startTs: local(2026, 10, 19) })
    expect(resolveDateBounds({ range: 'week' }, 0)).toEqual({ startTs: local(2026, 10, 18) })
    expect(resolveDateBounds({ range: 'month' })).toEqual({ startTs: local(2026, 10, 1) })
    for (const range of ['day', 'week', 'month'] as const) {
      for (const weekStart of [0, 1] as const) {
        expect(resolveDateBounds({ range }, weekStart).startTs).toBe(getDateRangeBounds(range, null, null, weekStart).start)
      }
    }
  })
})
