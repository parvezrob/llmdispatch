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
 * byte would double every future diff for no extra guarantee.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ENTRY_POINTS = ['index', 'postgres', 'conformance']

function build() {
  const result = spawnSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write('the build failed, so there is nothing to compare\n')
    process.exit(2)
  }
}

function main() {
  const update = process.argv.includes('--update')
  build()
  mkdirSync(join(ROOT, 'api'), { recursive: true })

  const differences = []
  for (const entry of ENTRY_POINTS) {
    const built = join(ROOT, 'dist', `${entry}.d.ts`)
    const snapshot = join(ROOT, 'api', `${entry}.d.ts`)
    if (!existsSync(built)) {
      process.stderr.write(`the build produced no declarations for '${entry}'\n`)
      process.exit(2)
    }
    const current = readFileSync(built, 'utf8')
    if (update) {
      writeFileSync(snapshot, current)
      continue
    }
    const recorded = existsSync(snapshot) ? readFileSync(snapshot, 'utf8') : null
    if (recorded !== current) differences.push(entry)
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
