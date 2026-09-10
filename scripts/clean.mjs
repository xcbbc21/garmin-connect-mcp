import { lstat, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Only the package's generated output is removable; never a caller-supplied path.
const output = fileURLToPath(new URL('../lib/', import.meta.url))
try {
  const info = await lstat(output)
  if (info.isSymbolicLink()) throw new Error('Refusing to clean a symlinked lib directory')
  await rm(output, { recursive: true })
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
