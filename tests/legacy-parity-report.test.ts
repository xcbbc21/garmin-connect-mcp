import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { listLegacyCapabilities } from '../src/legacy-capability-catalog'

describe('legacy capability parity inventory', () => {
  it('maps every migrated capability to a discoverable new MCP tool', () => {
    const baseline = JSON.parse(readFileSync(
      resolve(__dirname, 'fixtures/mcp-tools-baseline.json'), 'utf8',
    )) as { tools: Array<{ name: string }> }
    const names = new Set(baseline.tools.map(tool => tool.name))
    for (const capability of listLegacyCapabilities()) {
      if (capability.newTool && capability.migration !== 'do-not-copy') {
        expect(names).toContain(capability.newTool)
      }
    }
  })

  it('keeps all migrated legacy reads CN-scoped and source-only until live evidence exists', () => {
    for (const capability of listLegacyCapabilities()) {
      if (capability.migration === 'adapter') {
        expect(capability.regions).toEqual(['cn'])
        expect(capability.verification).toBe('source-only')
        expect(capability.access).toBe('read')
      }
    }
  })
})
