// Test-only Garmin Calendar peer.
//
// It runs as its own OS process precisely so that the tallies and the calendar
// outlive the MCP child under test. An in-process stub is unusable for recovery
// testing: killing the MCP process would erase the record of what was written,
// which is exactly the fact a restart test has to be able to check.
//
// It speaks HTTP over the loopback interface and holds every counter in its own
// memory. Two MCP processes pointed at the same URL therefore accumulate into
// one shared tally, and a test can read that tally at any time with
// `GET /__state` — no cooperation from the MCP process is required, and none is
// possible once that process is dead.
//
// It is not a Garmin emulator. It answers the handful of calls the write path
// makes and can be told to fail in the two ways that matter for recovery:
// losing a response after applying the write, and accepting a request it never
// answers.
'use strict'

const http = require('node:http')
const { writeFileSync } = require('node:fs')

const portFile = process.argv[2]
const stateFile = process.argv[3] ?? ''

const state = {
  pid: process.pid,
  /** Requests the peer actually accepted, per verb. */
  schedulePosts: 0,
  unschedulePosts: 0,
  createPosts: 0,
  calendarReads: 0,
  /** Requests whose effect was applied to the calendar, per verb. */
  scheduleApplied: 0,
  unscheduleApplied: 0,
  /** One record per accepted request, in arrival order. */
  posts: [],
  entries: [],
  workouts: Object.create(null),
  /**
   * Fault injection for the schedule verb.
   *
   *   none              answer normally
   *   drop_response     apply the write, then kill the socket without a reply
   *   hang              apply the write, then never reply and never close
   *   drop_before_apply kill the socket without applying anything
   */
  scheduleFault: { mode: 'none', fromCall: 1 },
  nextScheduleId: 0,
  nextWorkoutId: 0,
}

function persist() {
  if (!stateFile) return
  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
  } catch {
    // Diagnostics only: a failed dump must never change what the peer answers.
  }
}

function snapshot() {
  return {
    pid: state.pid,
    schedulePosts: state.schedulePosts,
    scheduleApplied: state.scheduleApplied,
    unschedulePosts: state.unschedulePosts,
    unscheduleApplied: state.unscheduleApplied,
    createPosts: state.createPosts,
    calendarReads: state.calendarReads,
    posts: state.posts.map(post => ({ ...post })),
    entries: state.entries.map(entry => ({ ...entry })),
    workouts: { ...state.workouts },
    scheduleFault: { ...state.scheduleFault },
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Kill the connection without a reply: the client sees a transport failure. */
function dropResponse(res) {
  res.socket.destroy()
}

async function handleSchedule(req, res) {
  const body = await readBody(req)
  const call = ++state.schedulePosts
  const fault = state.scheduleFault
  const armed = fault.mode !== 'none' && call >= fault.fromCall
  const at = new Date().toISOString()

  if (armed && fault.mode === 'drop_before_apply') {
    state.posts.push({
      call, kind: 'schedule', workoutId: body.workoutId, date: body.date,
      workoutScheduleId: null, applied: false, outcome: 'drop_before_apply', at,
    })
    persist()
    dropResponse(res)
    return
  }

  const workoutScheduleId = String(++state.nextScheduleId)
  state.entries.push({
    date: body.date,
    kind: 'workout',
    workoutId: body.workoutId ?? null,
    workoutScheduleId,
    title: `Workout ${body.workoutId}`,
    workoutUuid: null,
    planName: null,
    restDay: false,
    race: false,
    sport: 'running',
  })
  state.scheduleApplied += 1
  state.posts.push({
    call, kind: 'schedule', workoutId: body.workoutId, date: body.date,
    workoutScheduleId, applied: true, outcome: armed ? fault.mode : 'ok', at,
  })
  persist()

  if (armed && fault.mode === 'drop_response') {
    dropResponse(res)
    return
  }
  if (armed && fault.mode === 'hang') {
    // Applied, then silence. The socket stays open, so the caller is left
    // waiting — which is what a killed-then-restarted process has to recover
    // from without a second dispatch.
    return
  }
  send(res, 200, { workoutScheduleId, workoutId: body.workoutId, date: body.date })
}

async function handleUnschedule(req, res) {
  const body = await readBody(req)
  const call = ++state.unschedulePosts
  const index = state.entries.findIndex(entry => entry.workoutScheduleId === body.workoutScheduleId)
  const removed = index === -1 ? null : state.entries.splice(index, 1)[0]
  if (removed) state.unscheduleApplied += 1
  state.posts.push({
    call, kind: 'unschedule', workoutScheduleId: body.workoutScheduleId,
    applied: Boolean(removed), outcome: removed ? 'ok' : 'no_such_entry',
    at: new Date().toISOString(),
  })
  persist()
  send(res, 200, { removed: Boolean(removed) })
}

async function handleCreate(req, res) {
  const body = await readBody(req)
  const call = ++state.createPosts
  const workoutId = `created-${++state.nextWorkoutId}`
  state.workouts[workoutId] = {
    workoutId,
    workoutName: body.name ?? `Created ${workoutId}`,
    definition: body,
  }
  state.posts.push({
    call, kind: 'create', workoutId, applied: true, outcome: 'ok',
    at: new Date().toISOString(),
  })
  persist()
  send(res, 200, { workoutId })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = `${req.method} ${url.pathname}`
  const fail = (error) => {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }

  if (route === 'GET /__health') return send(res, 200, { ok: true, pid: state.pid })
  if (route === 'GET /__state') return send(res, 200, snapshot())
  if (route === 'POST /__reset') {
    state.schedulePosts = 0
    state.scheduleApplied = 0
    state.unschedulePosts = 0
    state.unscheduleApplied = 0
    state.calendarReads = 0
    state.posts = []
    state.scheduleFault = { mode: 'none', fromCall: 1 }
    persist()
    return send(res, 200, snapshot())
  }
  if (route === 'POST /__fault') {
    return readBody(req)
      .then(body => {
        state.scheduleFault = {
          mode: body.mode ?? 'none',
          fromCall: Number.isInteger(body.fromCall) ? body.fromCall : 1,
        }
        persist()
        send(res, 200, { scheduleFault: { ...state.scheduleFault } })
      })
      .catch(fail)
  }
  if (route === 'GET /__calendar') {
    state.calendarReads += 1
    const range = {
      startDate: url.searchParams.get('startDate'),
      endDate: url.searchParams.get('endDate'),
    }
    persist()
    // The peer pads nothing: the range it was asked for is the range it reports
    // as probed, so a caller that leans on unread padding fails loudly.
    return send(res, 200, {
      range: { ...range },
      probedRange: { ...range },
      entries: state.entries
        .filter(entry => entry.date >= range.startDate && entry.date <= range.endDate)
        .map(entry => ({ ...entry })),
      fetchedAt: new Date().toISOString(),
      complete: true,
      missingRanges: [],
      warnings: [],
      requestsIssued: 1,
    })
  }
  if (route === 'GET /api/workout') {
    return send(res, 200, { workouts: Object.values(state.workouts) })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/workout/')) {
    const workoutId = decodeURIComponent(url.pathname.slice('/api/workout/'.length))
    const workout = state.workouts[workoutId]
    if (!workout) return send(res, 404, { error: 'no such workout' })
    return send(res, 200, workout)
  }
  if (route === 'POST /api/workout') return handleCreate(req, res).catch(fail)
  if (route === 'POST /api/schedule') return handleSchedule(req, res).catch(fail)
  if (route === 'POST /api/unschedule') return handleUnschedule(req, res).catch(fail)

  send(res, 404, { error: `no route for ${route}` })
})

// A socket the handler deliberately destroys still emits its error here; it is
// the peer's intended behaviour, not a server fault.
server.on('clientError', (_error, socket) => socket.destroy())

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(portFile, String(port))
  process.stderr.write(`fake-garmin listening on ${port} (pid ${process.pid})\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
