// Test-only calendar peer for the stdio fixture.
//
// It implements the reader contract structurally and nothing else: the object
// handed to the service has a single `getCalendarRange` method and no write
// verb, so a read path that tries to dispatch through it cannot compile, let
// alone run. The write verbs live on the client fixture, which records what it
// was asked to schedule and removes entries on unschedule — that is what makes
// a later range read able to report "this workout is already on that day".
'use strict'

/** @type {Array<{ date: string, kind: string, workoutId: string|null, workoutScheduleId: string|null, title: string|null, workoutUuid: string|null, planName: string|null, restDay: boolean, race: boolean, sport: string|null }>} */
const entries = []
let rangeReads = 0

function addEntry({ workoutId, date, workoutScheduleId, title = null }) {
  entries.push({
    date,
    kind: 'workout',
    workoutId: workoutId ?? null,
    workoutScheduleId: workoutScheduleId ?? null,
    title,
    workoutUuid: null,
    planName: null,
    restDay: false,
    race: false,
    sport: 'running',
  })
}

function removeByScheduleId(workoutScheduleId) {
  const index = entries.findIndex(entry => entry.workoutScheduleId === workoutScheduleId)
  if (index === -1) return false
  entries.splice(index, 1)
  return true
}

const reader = {
  async getCalendarRange(range) {
    rangeReads += 1
    return {
      // The fixture pads nothing: the range it was asked for is the range it
      // reports as probed, so a test that tries to lean on padding fails loudly.
      range: { ...range },
      probedRange: { ...range },
      entries: entries
        .filter(entry => entry.date >= range.startDate && entry.date <= range.endDate)
        .map(entry => ({ ...entry })),
      fetchedAt: new Date().toISOString(),
      complete: true,
      missingRanges: [],
      warnings: [],
      requestsIssued: 1,
    }
  },
}

module.exports = {
  reader,
  entries,
  addEntry,
  removeByScheduleId,
  rangeReads: () => rangeReads,
}
