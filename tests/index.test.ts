import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

describe('public programmatic API', () => {
  it('imports with no logs, environment loading or server startup', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'garmin-api-import-'))
    try {
      writeFileSync(path.join(directory, '.env'), 'GARMIN_USERNAME=must-not-load@example.test\n')
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '-e', [
        'delete process.env.GARMIN_USERNAME',
        'const api = require(' + JSON.stringify(path.resolve(__dirname, '../src/index.ts')) + ')',
        'if (process.env.GARMIN_USERNAME) throw Error("dotenv loaded on import")',
        'for (const key of ["createMcpServer","GarminClient","GarminToolService","resolveConfig","createStderrLogger"]) if(typeof api[key] !== "function") throw Error(key)',
        'if ("apply" in api || "inject" in api) throw Error("obsolete plugin API")',
      ].join(';')], { cwd: directory, encoding: 'utf8', timeout: 10000 })
      expect({ status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
