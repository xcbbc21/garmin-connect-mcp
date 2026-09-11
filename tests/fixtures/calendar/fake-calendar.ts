/**
 * Shared in-memory Garmin Calendar reader for the write suites.
 *
 * Every write path now stands behind a *fresh* read of the target day, so a
 * suite that wants to see a dispatch has to state what the calendar looks like.
 * That is the point of this fixture: "the account can read its calendar and the
 * day is empty" becomes an explicit, visible precondition instead of an
 * accident of a missing dependency.
 *
 * It implements `CalendarLookup` exactly — read only. There is no schedule,
 * create or unschedule method here, so a test cannot accidentally give the
 * coordinator the ability to send a write through its reader.
 *
 * The defaults are the honest ones for a readable account:
 *   - a complete read that found nothing is `complete: true` (a *complete empty*
 *     read is not the same thing as `complete: false`);
 *   - an entry only matches a target when its `workoutId` (or, for an
 *     unschedule target, its `workoutScheduleId`) really matches;
 *   - an entry outside the requested range is never returned.
 */

import type {
  CalendarEntry,
  CalendarRange,
  CalendarSnapshot,
} from '../../../src/calendar/types'
import type { CalendarLookup } from '../../../src/write-operations/reconcile'

export interface FakeCalendarEntryInput {
  /** `YYYY-MM-DD` calendar day. */
  date: string
  workoutId?: string | null
  workoutScheduleId?: string | null
  title?: string | null
  kind?: CalendarEntry['kind']
  restDay?: boolean
  race?: boolean
}

/** How the next reads should behave. `complete` is the default. */
export type FakeCalendarReadMode =
  | { kind: 'complete' }
  /** Read succeeds but misses the given days: a complete read is impossible. */
  | { kind: 'incomplete'; missingRange: CalendarRange; warning?: string }
  /** The provider refuses or fails: the caller gets a thrown error. */
  | { kind: 'fail'; error: Error; times?: number }

export class FakeCalendar implements CalendarLookup {
  private entries: FakeCalendarEntryInput[] = []
  private mode: FakeCalendarReadMode = { kind: 'complete' }
  /** Every range the coordinator asked for, in order. */
  readonly reads: CalendarRange[] = []
  /** Total provider requests, mirroring `CalendarSnapshot.requestsIssued`. */
  requestsIssued = 0

  constructor(entries: FakeCalendarEntryInput[] = []) {
    this.entries = entries.map(entry => ({ ...entry }))
  }

  /** Add an entry, as if a human put it on the calendar outside this process. */
  add(entry: FakeCalendarEntryInput): void {
    this.entries.push({ ...entry })
  }

  /** Remove every entry that targets this exact calendar entry. */
  removeByScheduleId(workoutScheduleId: string): number {
    const before = this.entries.length
    this.entries = this.entries.filter(entry => entry.workoutScheduleId !== workoutScheduleId)
    return before - this.entries.length
  }

  /** Remove every entry that uses this workout template on this day. */
  removeByWorkoutAndDate(workoutId: string, date: string): number {
    const before = this.entries.length
    this.entries = this.entries.filter(
      entry => !(entry.workoutId === workoutId && entry.date === date),
    )
    return before - this.entries.length
  }

  /** Stop reporting this range completely, without pretending it is empty. */
  setIncomplete(range: CalendarRange, warning = 'fixture: PartialCalendarRead'): void {
    this.mode = { kind: 'incomplete', missingRange: { ...range }, warning }
  }

  /** Make the next `times` reads throw. `times` omitted means "always". */
  fail(error: Error, times?: number): void {
    this.mode = { kind: 'fail', error, ...(times === undefined ? {} : { times }) }
  }

  /** Back to a complete, successful read. */
  reset(): void {
    this.mode = { kind: 'complete' }
  }

  clear(): void {
    this.entries = []
  }

  /** Entries whose day falls inside the range, in insertion order. */
  private entriesIn(range: CalendarRange): CalendarEntry[] {
    return this.entries
      .filter(entry => entry.date >= range.startDate && entry.date <= range.endDate)
      .map(entry => ({
        date: entry.date,
        kind: entry.kind ?? 'workout',
        workoutId: entry.workoutId ?? null,
        workoutScheduleId: entry.workoutScheduleId ?? null,
        title: entry.title ?? null,
        workoutUuid: null,
        planName: null,
        restDay: entry.restDay ?? false,
        race: entry.race ?? false,
        sport: 'running',
      }))
  }

  async getCalendarRange(range: CalendarRange): Promise<CalendarSnapshot> {
    this.reads.push({ ...range })
    const mode = this.mode
    if (mode.kind === 'fail') {
      if (mode.times !== undefined) {
        const remaining = mode.times - 1
        this.mode = remaining > 0
          ? { kind: 'fail', error: mode.error, times: remaining }
          : { kind: 'complete' }
      }
      throw mode.error
    }

    this.requestsIssued += 1
    const fetchedAt = new Date().toISOString()
    if (mode.kind === 'incomplete') {
      const coversMissing = mode.missingRange.startDate <= range.endDate
        && mode.missingRange.endDate >= range.startDate
      return {
        range: { ...range },
        probedRange: { ...range },
        // An incomplete read still returns whatever it did see. The point is
        // that the caller may not read a *negative* out of it.
        entries: this.entriesIn(range),
        fetchedAt,
        complete: !coversMissing,
        missingRanges: coversMissing
          ? [{ startDate: mode.missingRange.startDate, endDate: mode.missingRange.endDate }]
          : [],
        warnings: coversMissing
          ? [`[CHUNK_READ_FAILED] ${mode.warning ?? 'fixture: PartialCalendarRead'}`]
          : [],
        requestsIssued: 1,
      }
    }

    return {
      range: { ...range },
      probedRange: { ...range },
      entries: this.entriesIn(range),
      fetchedAt,
      complete: true,
      missingRanges: [],
      warnings: [],
      requestsIssued: 1,
    }
  }
}

/** A readable account with a completely empty calendar. */
export function emptyCalendar(): FakeCalendar {
  return new FakeCalendar()
}
