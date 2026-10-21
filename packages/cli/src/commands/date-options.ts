import { getDateRangeBounds } from '../api/server.js'

export interface DateOptions {
  range?: 'day' | 'week' | 'month'
  from?: string
  to?: string
}

/** Bounds on `ts` in ms since epoch: `startTs` inclusive, `endTs` exclusive. */
export interface DateBounds {
  startTs?: number
  endTs?: number
}

/** A date option the command cannot use. The message is written for the terminal. */
export class DateOptionError extends Error {}

/** True for a real calendar date written as YYYY-MM-DD. */
function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return date.toISOString().slice(0, 10) === value
}

/**
 * The `ts` bounds for the date options of `summary` and `export`, computed the
 * way the dashboard computes its date ranges. A preset `range` starts where the
 * dashboard's preset of that name starts and has no end. `from` and `to` are
 * local calendar days and both are included: from local midnight of `from` up
 * to local midnight after `to`. Either can be given alone. The caller rejects
 * `range` together with `from` or `to`.
 */
export function resolveDateBounds(options: DateOptions, weekStart: 0 | 1 = 1): DateBounds {
  const { range, from, to } = options
  if (from !== undefined && !isCalendarDate(from)) {
    throw new DateOptionError(`Invalid --from date: ${from}. Use YYYY-MM-DD.`)
  }
  if (to !== undefined && !isCalendarDate(to)) {
    throw new DateOptionError(`Invalid --to date: ${to}. Use YYYY-MM-DD.`)
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new DateOptionError(`--from ${from} is after --to ${to}.`)
  }
  if (range) return { startTs: getDateRangeBounds(range, null, null, weekStart).start }
  // The dashboard's custom range for a single day gives that day's local
  // bounds, so each side can be taken on its own.
  return {
    startTs: from !== undefined ? getDateRangeBounds(null, from, from).start : undefined,
    endTs: to !== undefined ? getDateRangeBounds(null, to, to).end : undefined,
  }
}
