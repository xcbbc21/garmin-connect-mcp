import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
const manifest = readJson('package.json')
const lock = readJson('package-lock.json')
assert.equal(manifest.private, true, 'Source distribution must not publish to the occupied npm name')
assert.equal(manifest.name, 'garmin-connect-mcp')
assert.equal(manifest.dsh, undefined)
assert.equal(manifest.exports['./client'], undefined)
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
assert(!Object.keys(dependencies).some(name =>
  name.startsWith('@deepseek-ai/') || ['cordis', 'schemastery', 'react', '@types/react', 'esbuild'].includes(name)))
assert(!Object.keys(lock.packages).some(name => name.includes('node_modules/@deepseek-ai/')))

// Invoked through npm on every platform, including Windows (no shell required).
assert(process.env.npm_execpath, 'Run npm run pack:smoke')
const result = spawnSync(process.execPath, [process.env.npm_execpath,
  'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr)
const [pack] = JSON.parse(result.stdout)
const files = pack.files.map(file => file.path)
for (const name of ['lib/mcp.js', 'lib/auth-cli.js', 'lib/index.js', 'LICENSE',
  'NOTICE.md', 'skills/garmin-connect-mcp/SKILL.md', 'docs/migration.md', 'docs/client-setup.md']) {
  assert(files.includes(name), 'Missing package file: ' + name)
}
const forbidden = /(^|\/)(node_modules|tests|coverage|src|\.git)(\/|$)|dsh-client|cordis[.]patch|^lib\/(client\/|types\/client\/|tools\/)|embedded-auth-rpc|[.]session[.]json$|^CNAME$|^\.env$/
assert(!files.some(name => forbidden.test(name)), 'Obsolete or private files entered the package')
for (const name of files.filter(name => name.startsWith('lib/') && /\.(js|ts)$/.test(name))) {
  const source = readFileSync(path.join(root, name), 'utf8')
  assert(!/@deepseek-ai\/|DeepSeek Harness|\bDSH\b|cordis[.]patch/.test(source), 'Host coupling in ' + name)
}
console.log(JSON.stringify({ name: pack.name, version: pack.version, files: files.length,
  packageBytes: pack.size, unpackedBytes: pack.unpackedSize, audit: 'passed' }, null, 2))
