#!/usr/bin/env node
/**
 * Calls every built-in adapter against its real provider and checks that what comes back is
 * what the package documents.
 *
 * The three text adapters are called four times each: a plain prompt, a request for a JSON
 * object, an image and a PDF. The three image adapters are probed through `run()`, so the
 * core's own image header reader and SVG document check are part of what is exercised:
 * Gemini for two 1K images in one call (which also asks whether its image models take a
 * candidate count), OpenAI's Images API for two transparent 1K images and one 2K image at low
 * quality, and OpenRouter's Image API for one 1K raster image with its reported cost and one
 * SVG document from a vector model, whose shape is reported as a finding.
 *
 * Recorded fixtures prove the adapters read the shapes that were recorded; only this proves
 * the providers still send them. Manual by design: it spends money and needs keys, so it is
 * never wired into CI. A full run costs about $0.21, nearly all of it the images: about $0.07
 * for the two Gemini images (about $0.035 instead when the count is refused, since a refused
 * request is not billed and the retry asks for one image), about $0.01 and $0.03 for the
 * OpenAI images at low quality, about $0.02 for the OpenRouter raster image and $0.08 for the
 * SVG document. The text calls cost a fraction of a cent.
 *
 * Key custody is why this file and the runners are separate, and `./lib/live-check-plan.mjs`
 * holds the tables and the decision of which child starts with which credential. Each check
 * runs in a child process carrying exactly one credential, built from the shared allowlist; no
 * key is ever an argument, and the child's output is filtered on the way through.
 *
 * Usage: node scripts/live-check-providers.mjs [--release <path-to-tgz>]
 *   With `--release` the checks run from a throwaway project that installed that tarball, the
 *   OpenAI-compatible check is pinned to the official endpoint, and every check must run: a
 *   missing key is a failure. Without it they run against the working tree's current build and
 *   a check whose key is absent is skipped with a notice, which is for local development and
 *   is not evidence about a release. A locally set OPENAI_BASE_URL also skips the OpenAI
 *   image probes: OPENAI_API_KEY then belongs to the overridden endpoint, and the image probes
 *   only ever call the official one.
 *   Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY (the OpenAI-compatible check and the OpenAI image
 *   probes), GEMINI_API_KEY (the Gemini check and its image probe) and OPENROUTER_API_KEY.
 * Exit codes: 0 every check that had to run did and passed, 1 one did not, 2 wrong usage.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { buildChildEnvironment } from './lib/child-environment.mjs'
import {
  createConsumerProject,
  pinnedDevelopmentOverrides,
  pinnedDevelopmentVersion,
  runChild,
  runInConsumerProject,
  stopRunningChildren,
} from './lib/consumer-project.mjs'
import {
  CHECKS,
  ENDPOINT_OVERRIDE,
  IMAGE_PROBES,
  IMAGE_RUNNER,
  RUNNER,
  TOLERANCE,
  probeTableProblems,
  runChecks,
  secretsFor,
} from './lib/live-check-plan.mjs'

const ROOT = join(import.meta.dirname, '..')
const USAGE = 'usage: live-check-providers.mjs [--release <path-to-tgz>]\n'

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

/** Runs one check against the working tree's build, from the repository. */
function checkFromWorkingTree(check, values, home) {
  return runChild({
    command: process.execPath,
    args: [check.runner, ...check.args],
    cwd: ROOT,
    env: buildChildEnvironment(home, values),
    timeout: check.timeout,
    redact: secretsFor(check, process.env),
  })
}

async function main() {
  const { tarball, problem: usageProblem } = readArguments(process.argv.slice(2))
  if (usageProblem !== null) {
    process.stderr.write(usageProblem)
    return 2
  }
  const release = tarball !== null

  // The adapter's default endpoint is part of what a release check verifies, so an override is
  // refused rather than ignored.
  if (release && (process.env[ENDPOINT_OVERRIDE.name] ?? '') !== '') {
    process.stderr.write(
      'OPENAI_BASE_URL is set. A release check calls the official endpoint; unset it and run ' +
        'again.\n',
    )
    return 2
  }

  const tableProblems = probeTableProblems()
  if (tableProblems.length > 0) {
    for (const problem of tableProblems) process.stderr.write(`${problem}\n`)
    return 2
  }

  const workspace = mkdtempSync(join(tmpdir(), 'llmdispatch-live-check-'))
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
          overrides: pinnedDevelopmentOverrides(['zod']),
          files: [RUNNER, TOLERANCE, IMAGE_RUNNER, IMAGE_PROBES],
        })
      : null

    const outcome = await runChecks({
      checks: CHECKS,
      env: process.env,
      release,
      start: (check, values) =>
        project === null
          ? checkFromWorkingTree(check, values, workspace)
          : runInConsumerProject(project, {
              script: basename(check.runner),
              args: [...check.args, '--release'],
              values,
              timeout: check.timeout,
              redact: secretsFor(check, process.env),
            }),
      write: (line, stream) =>
        (stream === 'stderr' ? process.stderr : process.stdout).write(`${line}\n`),
    })
    ran = outcome.ran
    problems.push(...outcome.problems)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'unknown error')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  const total = String(CHECKS.length)
  if (problems.length > 0) {
    process.stdout.write(
      `${String(ran)} of ${total} check(s) ran, ${String(problems.length)} problem(s)\n`,
    )
    return 1
  }
  // Outside release mode the count is the verdict: "none failed" is equally true of a run that
  // called nothing.
  process.stdout.write(
    release
      ? `all ${total} check(s) ran against their providers and passed\n`
      : `${String(ran)} of ${total} check(s) ran and passed; ${String(CHECKS.length - ran)} ` +
          'were skipped, so this run is not evidence about a release\n',
  )
  return 0
}

/** Kills the child, removes the workspace and stops when this process is interrupted. */
function removeOnSignal(workspace) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\nstopped by ${signal}; cleaning up\n`)
      // The child first: a signal to this process is not delivered to it, so a runner holding
      // a credential would otherwise carry on orphaned.
      void stopRunningChildren().finally(() => {
        rmSync(workspace, { recursive: true, force: true })
        // A handler replaces the default disposition, so the exit must be explicit.
        process.exit(1)
      })
    })
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `the live check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`,
  )
  process.exitCode = 1
}
