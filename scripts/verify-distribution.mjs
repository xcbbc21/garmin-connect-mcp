import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = fileURLToPath(new URL('../', import.meta.url))
assert(process.env.npm_execpath, 'Run npm run test:distribution')
// npm records file dependencies relative to its canonical cwd. On macOS /var
// aliases /private/var; normalize both paths before installing the tarball.
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'garmin-distribution-')))
const consumer = path.join(directory, 'consumer')
const npm = (args, cwd = root) => {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args],
    { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 })
  assert.equal(result.status, 0, `${result.stderr || result.error?.message}\n${result.stdout}`)
  return result.stdout
}
let client
try {
  // Pack actual artifacts and install them without this checkout's dev dependencies.
  const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory]))
  await mkdir(consumer)
  npm(['install', path.join(directory, pack.filename), '--prefix', consumer,
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer)
  const packageRoot = path.join(consumer, 'node_modules', 'garmin-connect-mcp')
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  assert(installed.private)
  const tree = JSON.parse(npm(['ls', '--all', '--json'], consumer))
  assert(!JSON.stringify(tree).includes('@deepseek-ai/'))
  const importCheck = spawnSync(process.execPath, ['-e',
    'const api = require(process.argv[1]); if (typeof api.createMcpServer !== "function") process.exitCode = 1',
    packageRoot], { cwd: consumer, encoding: 'utf8', timeout: 10000 })
  assert.equal(importCheck.status, 0, importCheck.stderr)
  assert.equal(importCheck.stdout, '')
  assert.equal(importCheck.stderr, '')
  const authCheck = spawnSync(process.execPath, [path.join(packageRoot, 'lib/auth-cli.js'), '--help'],
    { cwd: consumer, encoding: 'utf8', timeout: 10000 })
  assert.equal(authCheck.status, 0, authCheck.stderr)
  assert.match(authCheck.stdout, /garmin-connect-auth serve/)
  client = new Client({ name: 'package-consumer', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(packageRoot, 'lib/mcp.js')], cwd: consumer,
    env: { GARMIN_USERNAME: 'fixture@example.test',
      GARMIN_SESSION_TOKEN_FILE: path.join(directory, 'missing.session.json') },
    stderr: 'pipe',
  })
  const errors = []
  client.onerror = error => errors.push(error)
  await client.connect(transport)
  const baseline = JSON.parse(await readFile(path.join(root, 'tests/fixtures/mcp-tools-baseline.json'), 'utf8'))
  assert.deepEqual(await client.listTools(), baseline)
  const preview = await client.callTool({ name: 'create_garmin_workout', arguments: {
    name: 'Package preview', steps: [{ type: 'interval', endCondition: 'time', endValue: 600 }],
  } })
  assert.equal(JSON.parse(preview.content[0].text).requiresConfirmation, true)
  assert.deepEqual(errors, [])
  await client.close()
  assert.equal(transport.pid, null)
  console.log(JSON.stringify({ distribution: 'passed', version: installed.version,
    tools: baseline.tools.length, runtimeOnlyInstall: true }))
} finally {
  await client?.close()
  await rm(directory, { recursive: true, force: true })
}
