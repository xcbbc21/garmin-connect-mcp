import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never let a suite read or write the developer's real write journal. Tests
// that care about journal contents still inject their own temp directory.
if (!process.env.GARMIN_STATE_DIR) {
  process.env.GARMIN_STATE_DIR = mkdtempSync(join(tmpdir(), 'garmin-jest-state-'))
}
