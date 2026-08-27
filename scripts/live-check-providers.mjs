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
/** Enough for any plausible run; the runner prints a handful of lines. */
const OUTPUT_LIMIT = 4 * 1024 * 1024

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

/** Runs one adapter's check against the working tree's build, from the repository. */
function checkFromWorkingTree(descriptor, home) {
  const result = spawnSync(process.execPath, [RUNNER, descriptor.name, descriptor.model], {
    cwd: ROOT,
    env: buildChildEnvironment(home, {
      [descriptor.key]: process.env[descriptor.key],
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    }),
    encoding: 'utf8',
    maxBuffer: OUTPUT_LIMIT,
    timeout: CHECK_DEADLINE,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const failure = result.error
  return {
    ok: failure === undefined && result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${failure === undefined ? '' : `\n${failure.message}`}`,
  }
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
  const problems = []
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
        process.stdout.write(
          `${descriptor.name}: skipped, ${descriptor.key} is not set — this run is not ` +
            'evidence about a release\n',
        )
        continue
      }

      // One credential per child, and only the one this adapter needs. The allowlist rejects
      // any name that is not a provider key, so this cannot quietly grow.
      const check =
        project === null
          ? checkFromWorkingTree(descriptor, workspace)
          : runInConsumerProject(project, {
              script: 'live-check.mjs',
              args: [descriptor.name, descriptor.model, '--release'],
              values: { [descriptor.key]: process.env[descriptor.key] },
              timeout: CHECK_DEADLINE,
            })
      process.stdout.write(check.output)
      if (!check.ok) problems.push(`${descriptor.name}: the check failed`)
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'unknown error')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  process.stdout.write(
    problems.length === 0
      ? `${String(PROVIDERS.length)} adapter(s) considered, none failed\n`
      : `${String(problems.length)} problem(s)\n`,
  )
  return problems.length === 0 ? 0 : 1
}

process.exitCode = main()
