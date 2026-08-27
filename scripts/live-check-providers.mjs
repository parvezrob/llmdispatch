#!/usr/bin/env node
/**
 * Calls every built-in adapter against its real provider, once with a plain prompt and once
 * asking for a JSON object, and checks that what comes back is what the package documents.
 *
 * Recorded fixtures prove the adapters read the shapes that were recorded. Only this proves
 * the providers still send them. It is a manual check by design: it spends money, it depends
 * on three services being up, and a key belongs to a person rather than to a workflow. It is
 * never wired into CI.
 *
 * Key custody is the reason this file and the runner are separate. Each provider is checked in
 * a child process whose environment is built from the shared allowlist and carries exactly one
 * credential — the other two do not exist in it. No key is ever an argument, and the runner
 * prints nothing that came from a request or a response.
 *
 * Usage: node scripts/live-check-providers.mjs [--release <path-to-tgz>]
 *   With `--release` the checks run from a throwaway project that installed that tarball, the
 *   OpenAI-compatible check is pinned to the official endpoint, and every adapter must run: a
 *   missing key is a failure. Without it they run against the working tree's current build and
 *   an adapter whose key is absent is skipped with a notice, which is for local development
 *   and is not evidence about a release.
 * Exit codes: 0 every adapter that had to run did and passed, 1 one did not, 2 wrong usage.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { buildChildEnvironment } from './lib/child-environment.mjs'
import {
  createConsumerProject,
  describeRun,
  pinnedDevelopmentVersion,
  runInConsumerProject,
} from './lib/consumer-project.mjs'

const ROOT = join(import.meta.dirname, '..')
const RUNNER = join(import.meta.dirname, 'runners', 'live-check.mjs')
const USAGE = 'usage: live-check-providers.mjs [--release <path-to-tgz>]\n'

/**
 * The adapters, each with the credential it needs and the model it is checked on.
 *
 * The models are the smallest each provider offers, and the runner asks for a handful of
 * tokens: a full run should cost a fraction of a cent. Change them here when a provider
 * retires one — nowhere else names a model.
 */
const PROVIDERS = [
  { name: 'anthropic', key: 'ANTHROPIC_API_KEY', model: 'claude-3-5-haiku-latest' },
  { name: 'openai-compatible', key: 'OPENAI_API_KEY', model: 'gpt-4.1-nano' },
  { name: 'gemini', key: 'GEMINI_API_KEY', model: 'gemini-2.0-flash-lite' },
]

/** Two calls to a live provider; anything beyond this is a hang, not a slow model. */
const CHECK_DEADLINE = 2 * 60_000

/** The one adapter whose endpoint may be pointed elsewhere, and the name that does it. */
const ENDPOINT_OVERRIDE = { provider: 'openai-compatible', name: 'OPENAI_BASE_URL' }

/** The tarball to check against, `null` for the working tree, or a usage failure. */
function readArguments(argv) {
  if (argv.length === 0) return { tarball: null, problem: null }
  if (argv.length !== 2 || argv[0] !== '--release') return { tarball: null, problem: USAGE }
  const named = argv[1]
  const tarball = isAbsolute(named) ? named : resolve(named)
  let file = null
  try {
    file = statSync(tarball)
  } catch {
    // Reported below, together with the case of a path that is not a file at all.
  }
  if (file === null || !file.isFile()) {
    return { tarball: null, problem: `'${named}' is not an existing tarball file\n${USAGE}` }
  }
  return { tarball, problem: null }
}

/**
 * The environment names one adapter's child is given, beyond the allowlist's own.
 *
 * Exactly one credential, and the endpoint override only where it means anything. An adapter
 * that has no use for a name does not receive it: this is the reason each provider gets a
 * process of its own, applied to everything in the environment rather than to keys alone.
 */
function childValues(descriptor) {
  const values = { [descriptor.key]: process.env[descriptor.key] }
  if (descriptor.name === ENDPOINT_OVERRIDE.provider) {
    values[ENDPOINT_OVERRIDE.name] = process.env[ENDPOINT_OVERRIDE.name]
  }
  return values
}

/** Runs one adapter's check against the working tree's build, from the repository. */
function checkFromWorkingTree(descriptor, home) {
  // Streamed rather than collected: the child redacts every line it writes, so there is
  // nothing for this process to hold back, and a call that hangs to its deadline still leaves
  // behind whatever it managed to say.
  const result = spawnSync(process.execPath, [RUNNER, descriptor.name, descriptor.model], {
    cwd: ROOT,
    env: buildChildEnvironment(home, childValues(descriptor)),
    timeout: CHECK_DEADLINE,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return describeRun(result)
}

function main() {
  const { tarball, problem: usageProblem } = readArguments(process.argv.slice(2))
  if (usageProblem !== null) {
    process.stderr.write(usageProblem)
    return 2
  }
  const release = tarball !== null

  // The adapter's own default endpoint is part of what a release check verifies. An override
  // would silently turn the check into one against something else, so it is refused rather
  // than ignored — a run that cannot be what it claims must not report a verdict.
  if (release && (process.env.OPENAI_BASE_URL ?? '') !== '') {
    process.stderr.write(
      'OPENAI_BASE_URL is set. A release check calls the official endpoint; unset it and run ' +
        'again.\n',
    )
    return 2
  }

  const workspace = mkdtempSync(join(tmpdir(), 'llmswitch-live-check-'))
  removeOnSignal(workspace)
  const problems = []
  let ran = 0
  try {
    const project = release
      ? createConsumerProject({
          workspace,
          name: 'consumer',
          tarballPath: tarball,
          packages: [pinnedDevelopmentVersion('zod')],
          files: [RUNNER],
        })
      : null

    for (const descriptor of PROVIDERS) {
      const present = (process.env[descriptor.key] ?? '') !== ''
      if (!present) {
        if (release) {
          problems.push(`${descriptor.name}: ${descriptor.key} is not set`)
          continue
        }
        process.stdout.write(`${descriptor.name}: skipped, ${descriptor.key} is not set\n`)
        continue
      }

      // One credential per child, and only the one this adapter needs. The allowlist rejects
      // any name that is not a provider key, so this cannot quietly grow.
      ran += 1
      const check =
        project === null
          ? checkFromWorkingTree(descriptor, workspace)
          : runInConsumerProject(project, {
              script: 'live-check.mjs',
              args: [descriptor.name, descriptor.model, '--release'],
              values: { [descriptor.key]: process.env[descriptor.key] },
              timeout: CHECK_DEADLINE,
            })
      if (check.note !== '') process.stderr.write(`${descriptor.name}: ${check.note}\n`)
      if (!check.ok) problems.push(`${descriptor.name}: the check failed`)
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'unknown error')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  const total = String(PROVIDERS.length)
  if (problems.length > 0) {
    process.stdout.write(
      `${String(ran)} of ${total} adapter(s) ran, ${String(problems.length)} problem(s)\n`,
    )
    return 1
  }
  // Outside release mode the count is the verdict: "none failed" is just as true of a run
  // where every key was missing and nothing was called at all.
  process.stdout.write(
    release
      ? `all ${total} adapter(s) ran against their providers and passed\n`
      : `${String(ran)} of ${total} adapter(s) ran and passed; ${String(PROVIDERS.length - ran)} ` +
          'had no key and were skipped, so this run is not evidence about a release\n',
  )
  return 0
}

/** Removes the workspace and stops when this process is interrupted. */
function removeOnSignal(workspace) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\nstopped by ${signal}; cleaning up\n`)
      rmSync(workspace, { recursive: true, force: true })
      // A handler replaces the default disposition, so the exit has to be explicit; a stopped
      // check verified nothing, which is a failure.
      process.exit(1)
    })
  }
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(
    `the live check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`,
  )
  process.exitCode = 1
}
