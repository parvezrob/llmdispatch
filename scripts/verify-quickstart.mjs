#!/usr/bin/env node
/**
 * Follows the README quickstart literally, in a clean directory, against a packed tarball.
 *
 * Extraction is the strict one the fixture checker also applies: the `## Quickstart`
 * section must contain exactly one `bash` install fence followed by one `ts` code fence.
 * The install is the documented command with only the unpublished registry argument
 * `llmswitch` replaced by the tarball path; the code fence is written byte-for-byte to its
 * own file — never edited, wrapped or rewritten — and executed by a two-line harness that
 * imports it. Provider API keys are scrubbed from the child environment, so the run cannot
 * become live billed traffic: without a key, the documented outcome is an `LLMSwitchError`
 * with code `INVALID_CONFIG` from the unresolvable key, and that exact rejection is the
 * pass condition. Anything else — a ReferenceError, a different code, a run that resolves —
 * means the printed quickstart is wrong.
 *
 * Needs Node >= 23.6 (native type stripping executes the `ts` fence as printed) and network
 * access for the documented `npm install` of `zod`.
 *
 * Usage: node scripts/verify-quickstart.mjs [path-to-tarball]
 *   With no argument, packs the working tree first. CI passes the audited tarball.
 * Exit codes: 0 the quickstart behaves as printed, 1 it does not, 2 bad arguments.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { readQuickstart } from './lib/quickstart-section.mjs'

const ROOT = join(import.meta.dirname, '..')
const README = join(ROOT, 'README.md')
const USAGE = 'usage: verify-quickstart.mjs [path-to-tarball]\n'
// The provider keys the quickstart's resolvers read (matched case-insensitively), plus
// NODE_OPTIONS: a permitted --require/--import preload runs before the README module and
// could repopulate what the scrub removed.
const BLOCKED_VARIABLES = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'NODE_OPTIONS',
])

/**
 * The harness: import the printed file, require the documented rejection — a real
 * `LLMSwitchError` from the installed package, `INVALID_CONFIG`, detected locally (the
 * unresolvable key), never a dispatched provider rejection.
 */
const HARNESS = `import { LLMSwitchError } from 'llmswitch'
try {
  await import('./quickstart.ts')
  console.error('the quickstart ran to completion without an API key — expected INVALID_CONFIG')
  process.exit(1)
} catch (error) {
  if (
    error instanceof LLMSwitchError &&
    error.code === 'INVALID_CONFIG' &&
    error.detectedAt === 'local'
  ) {
    console.log('the quickstart behaves as printed: keyless run ends in INVALID_CONFIG (local)')
    process.exit(0)
  }
  console.error('the quickstart failed, but not the documented way:', error)
  process.exit(1)
}
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.length > 1) {
    process.stderr.write(USAGE)
    return 2
  }

  const problems = []
  const quickstart = readQuickstart(readFileSync(README, 'utf8'), problems)
  if (quickstart === null) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }
  if (quickstart.install !== 'npm install llmswitch zod') {
    process.stderr.write(
      `README.md ## Quickstart: the install fence reads '${quickstart.install}', not the documented 'npm install llmswitch zod' this script derives from\n`,
    )
    return 1
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !BLOCKED_VARIABLES.has(key.toUpperCase())),
  )

  let tarball = argv[0]
  if (tarball !== undefined) {
    if (!isAbsolute(tarball)) tarball = resolve(tarball)
    let file = null
    try {
      file = statSync(tarball)
    } catch {
      // reported below
    }
    if (file === null || !file.isFile()) {
      process.stderr.write(`'${tarball}' is not an existing tarball file\n${USAGE}`)
      return 2
    }
  }

  const directory = mkdtempSync(join(tmpdir(), 'llmswitch-quickstart-'))
  // Names which stage broke, so a registry flake in CI reads as infrastructure noise
  // rather than a defective quickstart.
  let step = 'packing the working tree'
  try {
    if (tarball === undefined) {
      const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
        cwd: ROOT,
        encoding: 'utf8',
        env: environment,
      })
      tarball = join(directory, JSON.parse(packed)[0].filename)
    }

    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: 'quickstart', private: true, type: 'module' }, null, 2)}\n`,
    )
    // The documented command, with only the unpublished registry argument replaced.
    const install = quickstart.install
      .split(' ')
      .map((word) => (word === 'llmswitch' ? tarball : word))
    step = 'installing the documented packages'
    execFileSync('npm', install.slice(1), {
      cwd: directory,
      env: environment,
      stdio: 'inherit',
    })

    writeFileSync(join(directory, 'quickstart.ts'), quickstart.code)
    writeFileSync(join(directory, 'main.mjs'), HARNESS)
    step = 'executing the printed quickstart'
    execFileSync(process.execPath, ['main.mjs'], {
      cwd: directory,
      env: environment,
      stdio: 'inherit',
    })
    return 0
  } catch {
    process.stderr.write(`the quickstart walk-through failed while ${step} — output above\n`)
    return 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

process.exitCode = main()
