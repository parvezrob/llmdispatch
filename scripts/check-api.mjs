#!/usr/bin/env node
/**
 * Keeps a readable copy of the public type surface in `api/` and fails when the build
 * no longer matches it.
 *
 * The point is that changing what the package exports is never invisible: it shows up
 * as a diff in the pull request, in a file anyone can read, instead of being buried in
 * `dist/`.
 *
 * Usage:
 *   node scripts/check-api.mjs            build, then compare (exit 1 on any difference)
 *   node scripts/check-api.mjs --update   build, then rewrite the snapshots
 *
 * Only the `import` declarations are snapshotted. The `require` ones are proved correct
 * by the package-typing check that runs alongside this one, and holding both to the
 * byte would double every future diff for no extra guarantee. Declarations two entry points
 * share are emitted as a chunk; that file is recorded too, since most of the surface lives
 * there once more than one entry point uses it.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ENTRY_POINTS = ['index', 'postgres', 'conformance']

function build() {
  const result = spawnSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write('the build failed, so there is nothing to compare\n')
    process.exit(2)
  }
}

/**
 * Every declaration file under a directory, relative to it and sorted.
 *
 * Nested as well as flat: a chunk the bundler puts in a subdirectory is as much a part of the
 * published surface as one beside the entry points.
 */
function declarations(directory, prefix = '') {
  if (!existsSync(directory)) return []
  const found = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...declarations(directory, path))
    else if (entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found.sort()
}

function main() {
  const update = process.argv.includes('--update')
  build()
  mkdirSync(join(ROOT, 'api'), { recursive: true })

  for (const entry of ENTRY_POINTS) {
    if (existsSync(join(ROOT, 'dist', `${entry}.d.ts`))) continue
    process.stderr.write(`the build produced no declarations for '${entry}'\n`)
    process.exit(2)
  }

  const built = declarations(join(ROOT, 'dist'))
  const differences = []
  for (const name of built) {
    const current = readFileSync(join(ROOT, 'dist', name), 'utf8')
    const snapshot = join(ROOT, 'api', name)
    if (update) {
      mkdirSync(dirname(snapshot), { recursive: true })
      writeFileSync(snapshot, current)
      continue
    }
    const recorded = existsSync(snapshot) ? readFileSync(snapshot, 'utf8') : null
    if (recorded !== current) differences.push(name)
  }
  // A snapshot the build no longer produces would otherwise sit in `api/` unread.
  for (const name of declarations(join(ROOT, 'api'))) {
    if (built.includes(name)) continue
    if (update) rmSync(join(ROOT, 'api', name))
    else differences.push(`${name} (recorded, no longer built)`)
  }

  if (update) {
    process.stdout.write('public type surface recorded\n')
    return 0
  }
  if (differences.length > 0) {
    process.stderr.write(
      `the public type surface changed for: ${differences.join(', ')}\n` +
        "review the change, then run 'npm run api:update' to record it\n",
    )
    return 1
  }
  process.stdout.write('public type surface unchanged\n')
  return 0
}

process.exitCode = main()
