/**
 * C10 audit, pinned as a test: **every Garmin write verb in `src` is dispatched
 * through the coordinator's injected writer, never straight from a tool
 * handler.**
 *
 * The runtime proof that the five write tools route through the coordinator
 * lives in `tests/write-paths.test.ts` and the recovery suites. This file is
 * the complementary structural proof: it reads the source tree and fails as
 * soon as a new call site appears that would put a write verb back in the hands
 * of a caller that has no journal.
 *
 * The rule it enforces is narrow and checkable. A *dispatch site* is a call of
 * the form `<receiver>.<verb>(` where `<verb>` is one of the three transport
 * verbs (`addWorkout`, `scheduleWorkout`, `unscheduleWorkout`) or one of the
 * three coordinator writer verbs (`addWorkout`, `schedule`, `unschedule`).
 * Every dispatch site must have a receiver from a reviewed set, and every site
 * inside `src/tool-service.ts` must sit in a method whose whole job is to build
 * an injected writer or to hand one to a coordinator executor.
 *
 * The expected inventory is pinned deliberately. Adding a write path is a
 * change that must be argued for, so the test fails on a new site instead of
 * quietly accepting it; updating the pin is the point at which a reviewer is
 * forced to ask whether the new path is journaled.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(__dirname, '..', 'src')

/** The three verbs as they are named on the Garmin data client. */
const CLIENT_VERBS = ['addWorkout', 'scheduleWorkout', 'unscheduleWorkout']
/** The three verbs as they are named on the coordinator's injected writer. */
const WRITER_VERBS = ['addWorkout', 'schedule', 'unschedule']

interface Site {
  file: string
  line: number
  receiver: string
  verb: string
  /** Nearest enclosing 2-space-indented method name, or `(top)` at file scope. */
  enclosing: string
}

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

function collect(verbs: string[]): Site[] {
  const call = new RegExp(`([A-Za-z_$][\\w$.]*)\\.(${verbs.join('|')})\\s*\\(`)
  const method = /^ {2}(?:(?:private|protected|public|static|async|readonly|abstract|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:\(|<)/
  const sites: Site[] = []
  for (const path of sourceFiles(SRC)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const match = line.match(call)
      if (!match) return
      let enclosing = '(top)'
      for (let back = index; back >= 0; back -= 1) {
        const methodMatch = lines[back].match(method)
        if (methodMatch) {
          enclosing = methodMatch[1]
          break
        }
      }
      sites.push({
        file: relative(SRC, path),
        line: index + 1,
        receiver: match[1],
        verb: match[2],
        enclosing,
      })
    })
  }
  return sites
}

/**
 * The only methods in `src/tool-service.ts` allowed to touch a client write
 * verb, with the reason each one is safe. The first two *construct* a writer;
 * the other three hand an inline writer object to a coordinator executor that
 * decides from the journal whether to call it.
 */
const WRITER_CONSTRUCTION = new Set(['writeCoordinator', 'resumeWriter'])
const WRITER_INJECTION = new Set(['createWorkout', 'createAndScheduleWorkout', 'unscheduleWorkout'])

describe('write dispatch inventory', () => {
  const clientSites = collect(CLIENT_VERBS)
  const writerSites = collect(WRITER_VERBS)

  it('reaches the Garmin data client from one file only: the tool service', () => {
    const files = [...new Set(clientSites.map(site => site.file))].sort()
    expect(files).toEqual([
      'mcp.ts',
      'tool-service.ts',
      'write-operations/coordinator.ts',
    ])
  })

  it('never names the data client in the MCP layer', () => {
    // `src/mcp.ts` may only call the service facade. Anything else would let a
    // tool handler reach the transport without passing the coordinator.
    const mcp = readFileSync(join(SRC, 'mcp.ts'), 'utf8')
    expect(mcp).not.toMatch(/\.client\b/)
    for (const site of clientSites.filter(s => s.file === 'mcp.ts')) {
      expect(site.receiver).toBe('service')
    }
    // The two facade adapters are the only place the MCP layer names a verb.
    expect(clientSites.filter(s => s.file === 'mcp.ts').map(s => s.verb).sort())
      .toEqual(['scheduleWorkout', 'unscheduleWorkout'])
  })

  it('dispatches every client write verb from a coordinator writer, in a reviewed method', () => {
    const sites = clientSites.filter(s => s.file === 'tool-service.ts')
    expect(sites.map(s => `${s.enclosing}.${s.receiver}.${s.verb}`).sort()).toEqual([
      'createAndScheduleWorkout.this.client.addWorkout',
      'createAndScheduleWorkout.this.client.scheduleWorkout',
      'createWorkout.this.client.addWorkout',
      'resumeWriter.this.client.addWorkout',
      'resumeWriter.this.client.scheduleWorkout',
      'resumeWriter.this.client.unscheduleWorkout',
      'unscheduleWorkout.this.client.unscheduleWorkout',
      'writeCoordinator.this.client.scheduleWorkout',
    ])
    for (const site of sites) {
      expect(site.receiver).toBe('this.client')
      expect(
        WRITER_CONSTRUCTION.has(site.enclosing) || WRITER_INJECTION.has(site.enclosing),
      ).toBe(true)
    }
  })

  it('lets the coordinator reach Garmin only through its injected writer', () => {
    const coordinator = clientSites.filter(s => s.file === 'write-operations/coordinator.ts')
    // One create dispatch; schedule and unschedule use their own verb names and
    // are covered by the assertion below.
    expect(coordinator.map(s => `${s.enclosing}.${s.receiver}.${s.verb}`)).toEqual([
      'dispatchCreate.writer.addWorkout',
    ])

    const writer = writerSites.filter(s => s.file === 'write-operations/coordinator.ts')
    expect(writer.map(s => `${s.enclosing}.${s.receiver}.${s.verb}`).sort()).toEqual([
      'dispatchCreate.writer.addWorkout',
      'dispatchSchedule.writer.schedule',
      'dispatchUnschedule.writer.unschedule',
      'executeSchedule.this.options.writer.schedule',
    ])
    for (const site of writer) {
      expect(['writer', 'this.options.writer']).toContain(site.receiver)
    }
  })

  it('contains no dispatch site anywhere else in the source tree', () => {
    const everywhere = new Set([
      ...clientSites.map(site => site.file),
      ...writerSites.map(site => site.file),
    ])
    expect([...everywhere].sort()).toEqual([
      'mcp.ts',
      'tool-service.ts',
      'write-operations/coordinator.ts',
    ])
  })
})
