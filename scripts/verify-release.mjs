#!/usr/bin/env node
/**
 * Verifies a packed tarball end to end, from outside the repository's own tree.
 *
 * The tarball is installed into a throwaway project, the installed bytes are checked against
 * it, and the check itself then runs from inside that project: it applies the packaged
 * migration to a real PostgreSQL in a schema of its own and runs all three conformance
 * harnesses — the two store suites against the installed PostgreSQL stores, the provider suite
 * against a fixture backend. There is no partial pass: a failing case and a skipped one both
 * end the run non-zero, because a release must not ship on an unverified classification.
 *
 * The database must be a throwaway on this machine. The migration creates and drops a schema,
 * and the store suites write and truncate; nothing about the run is safe to point at a
 * database anyone else is using, so only a loopback host is accepted.
 *
 * Usage: node scripts/verify-release.mjs <path-to-tgz>
 * Needs `DATABASE_URL`, pointing at 127.0.0.1, ::1 or localhost.
 *
 * A database for the run, thrown away with the container:
 *
 *   docker run --rm -d --name llmswitch-verify-db -p 127.0.0.1:5433:5432 \
 *     -e POSTGRES_PASSWORD=<throwaway> \
 *     postgres:14@sha256:2fdfb9b432d4a73bd3eea3d989752c1e669b68d502347e0bfd2cc6d709f3d6b4
 *   export DATABASE_URL=postgres://postgres:<throwaway>@127.0.0.1:5433/postgres
 *   npm run verify:release -- <path-to-tgz>
 *   docker rm -f llmswitch-verify-db
 *
 * The image is pinned by digest rather than by tag so two runs a month apart are the same
 * check. Exit codes: 0 verified, 1 a check failed, 2 wrong usage or a missing database.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  createConsumerProject,
  pinnedDevelopmentVersion,
  runInConsumerProject,
} from './lib/consumer-project.mjs'
import { hashFile } from './lib/installed-package.mjs'

const USAGE = 'usage: verify-release.mjs <path-to-tgz>\n'
const RUNNER = join(import.meta.dirname, 'runners', 'release-conformance.mjs')
const TEMPLATE = join(import.meta.dirname, 'fixtures', 'openai-chat-completion.json')

/** The only hosts a run may write to. Everything it does to a database is destructive. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Long enough for the suites on a cold database, short enough that a hang is a failure. */
const CHECK_DEADLINE = 10 * 60_000

/** Why this database may not be used, or `null` when it may. */
function describeUnusableDatabase(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'DATABASE_URL is not a URL'
  }
  const host = parsed.hostname
  if (host === '') return 'DATABASE_URL names no host'
  if (!LOOPBACK.has(host)) {
    return (
      `DATABASE_URL points at '${host}'. This check creates and drops schemas and truncates ` +
      'tables, so it only runs against a throwaway database on this machine: 127.0.0.1, ::1 ' +
      'or localhost'
    )
  }
  return null
}

function main() {
  const argv = process.argv.slice(2)
  const [tarball] = argv
  if (argv.length !== 1 || tarball === undefined) {
    process.stderr.write(USAGE)
    return 2
  }
  const tarballPath = isAbsolute(tarball) ? tarball : resolve(tarball)
  let file = null
  try {
    file = statSync(tarballPath)
  } catch {
    // Reported below, together with the case of a path that is not a file at all.
  }
  if (file === null || !file.isFile()) {
    process.stderr.write(`'${tarball}' is not an existing tarball file\n${USAGE}`)
    return 2
  }

  const databaseUrl = process.env.DATABASE_URL ?? ''
  if (databaseUrl === '') {
    process.stderr.write(`DATABASE_URL is not set\n${USAGE}`)
    return 2
  }
  const unusable = describeUnusableDatabase(databaseUrl)
  if (unusable !== null) {
    process.stderr.write(`${unusable}\n`)
    return 2
  }

  const before = hashFile(tarballPath)
  const workspace = mkdtempSync(join(tmpdir(), 'llmswitch-release-'))
  try {
    const project = createConsumerProject({
      workspace,
      name: 'consumer',
      tarballPath,
      // The peer the package declares, and the driver it deliberately does not ship: a
      // project that installs llmswitch has to bring both, so this one does too.
      packages: [pinnedDevelopmentVersion('zod'), pinnedDevelopmentVersion('pg')],
      files: [RUNNER, TEMPLATE],
    })

    // A schema of this run's own, so a leftover from an interrupted run cannot be mistaken
    // for what this one applied.
    const schema = `release_${randomBytes(4).toString('hex')}`
    const check = runInConsumerProject(project, {
      script: 'release-conformance.mjs',
      args: [schema],
      values: { DATABASE_URL: databaseUrl },
      timeout: CHECK_DEADLINE,
    })
    process.stdout.write(check.output)
    if (!check.ok) return 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`)
    return 1
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  if (hashFile(tarballPath) !== before) {
    process.stdout.write('the tarball changed while it was being verified\n')
    return 1
  }
  process.stdout.write(
    'the installed tarball applied its packaged migration to PostgreSQL and passed all ' +
      `three conformance suites with nothing skipped — from sha256 ${before}\n`,
  )
  return 0
}

process.exitCode = main()
