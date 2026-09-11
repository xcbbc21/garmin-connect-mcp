import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A write journal deliberately outlives a service instance, so a directory
// shared across tests would leak `prepared`/`unknown` records between them.
// Give every test its own directory; tests that assert on journal contents
// still inject an explicit one.
beforeEach(() => {
  process.env.GARMIN_STATE_DIR = mkdtempSync(join(tmpdir(), 'garmin-jest-state-'))
})
