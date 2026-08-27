#!/usr/bin/env node
/**
 * Verifies a packed tarball end to end, from outside the repository's own tree.
 *
 * The tarball is installed into a throwaway project, the installed bytes are checked against
 * it, and the check runs from inside that project: it applies the packaged migration to a real
 * PostgreSQL in a schema of its own and runs all three conformance suites. A skipped case
 * fails the run as a failing one does — a release must not ship on an unverified
 * classification. The suites `import` the package, so they exercise its ESM build; the
 * CommonJS build is covered by the consumer fixtures.
 *
 * This process owns the schema and drops it on every exit path, including signals: the runner
 * it starts can be killed and cannot be relied on to tidy up after itself. A drop that fails
 * is reported and makes the run non-zero.
 *
 * Usage: node scripts/verify-release.mjs <path-to-tgz>
 * Needs `DATABASE_URL` in exactly one shape: postgres://user:password@127.0.0.1:port/database —
 * an address in 127.0.0.0/8, an explicit port, and no query string or fragment.
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
 * The image is pinned by digest so two runs a month apart are the same check.
 * Exit codes: 0 verified, 1 a check failed, 2 wrong usage or a missing database.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import pg from 'pg'

import {
  createConsumerProject,
  pinnedDevelopmentOverrides,
  pinnedDevelopmentVersion,
  runInConsumerProject,
  stopRunningChildren,
} from './lib/consumer-project.mjs'
import { describeUnusableDatabase } from './lib/database-target.mjs'
import { hashFile } from './lib/installed-package.mjs'

const USAGE = 'usage: verify-release.mjs <path-to-tgz>\n'
const RUNNER = join(import.meta.dirname, 'runners', 'release-conformance.mjs')
const TEMPLATE = join(import.meta.dirname, 'fixtures', 'openai-chat-completion.json')

/** What a project installing llmswitch has to bring: the declared peer and the driver. */
const PEERS = ['zod', 'pg', 'pg-connection-string']

/** Long enough for the suites on a cold database, short enough that a hang is a failure. */
const CHECK_DEADLINE = 10 * 60_000
/** Dropping one schema is one statement; longer than this means nothing is coming back. */
const CLEANUP_DEADLINE = 30_000

/**
 * What this run created and must remove. `leftover` records a removal that failed, so the run
 * cannot then report success.
 *
 * @type {{
 *   workspace: string | null
 *   schema: string | null
 *   databaseUrl: string | null
 *   leftover: boolean
 * }}
 */
const owned = { workspace: null, schema: null, databaseUrl: null, leftover: false }

/** The clean-up already under way, so a second caller waits for it instead of starting one. */
let releasing = null

/**
 * Drops the schema and removes the workspace, once.
 *
 * Returns the in-flight promise rather than a "done" flag so an interrupt arriving mid-drop
 * waits for it instead of exiting the process out from under it.
 */
function releaseWhatThisRunOwns() {
  releasing ??= release()
  return releasing
}

/** The clean-up itself. Called once; everything else waits on the promise it returned. */
async function release() {
  if (owned.schema !== null && owned.databaseUrl !== null) {
    const pool = new pg.Pool({
      connectionString: owned.databaseUrl,
      connectionTimeoutMillis: CLEANUP_DEADLINE,
      // The connection timeout bounds reaching the server, not the statement: without these
      // a drop waiting on a lock would hang the signal path.
      statement_timeout: CLEANUP_DEADLINE,
      query_timeout: CLEANUP_DEADLINE,
    })
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${owned.schema}" CASCADE`)
    } catch {
      owned.leftover = true
      process.stderr.write(
        `the schema ${owned.schema} could not be dropped. If the run reached the database, ` +
          `it is still there — remove it with: DROP SCHEMA IF EXISTS "${owned.schema}" CASCADE\n`,
      )
    } finally {
      await pool.end().catch(() => undefined)
    }
  }
  if (owned.workspace !== null) {
    // A throw here would become an unhandled rejection through the memoised promise.
    try {
      rmSync(owned.workspace, { recursive: true, force: true })
    } catch {
      owned.leftover = true
      process.stderr.write(`the directory ${owned.workspace} could not be removed\n`)
    }
  }
}

/** Cleans up and stops when this process is interrupted, rather than leaving a schema behind. */
function cleanUpOnSignal() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\nstopped by ${signal}; cleaning up\n`)
      // The child first: a signal to this process is not delivered to it, so dropping the
      // schema while it is still writing to it would leave an orphan behind.
      void stopRunningChildren()
        .then(() => releaseWhatThisRunOwns())
        .finally(() => {
          // A handler replaces the default disposition, so the exit must be explicit.
          process.exit(1)
        })
    })
  }
}

/**
 * Drops every `PG*` name from this process's environment, so its pools connect on the
 * connection string alone — as the children already do under their allowlist. The driver reads
 * these as defaults, so an ambient `PGSSLMODE` or `PGPORT` could otherwise make the clean-up
 * connect differently from the run it is cleaning up after.
 */
function forgetAmbientPostgresSettings() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PG')) Reflect.deleteProperty(process.env, name)
  }
}

/** The tarball to verify, or the reason there is nothing to verify. */
function readArguments(argv) {
  const [named] = argv
  if (argv.length !== 1 || named === undefined) return { tarball: null, problem: USAGE }
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

async function main() {
  const { tarball, problem: usageProblem } = readArguments(process.argv.slice(2))
  if (usageProblem !== null) {
    process.stderr.write(usageProblem)
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
  forgetAmbientPostgresSettings()

  const before = hashFile(tarball)
  cleanUpOnSignal()
  owned.databaseUrl = databaseUrl
  owned.workspace = mkdtempSync(join(tmpdir(), 'llmswitch-release-'))
  try {
    const project = createConsumerProject({
      workspace: owned.workspace,
      name: 'consumer',
      tarballPath: tarball,
      // The declared peer, the driver the package does not ship, and the parser the guard
      // above judged the connection string with. What they in turn require is pinned as
      // overrides rather than installed, so an optional dependency stays optional.
      packages: PEERS.map((name) => pinnedDevelopmentVersion(name)),
      overrides: pinnedDevelopmentOverrides(PEERS),
      files: [RUNNER, TEMPLATE],
    })

    // A schema of this run's own, so a leftover from an interrupted run is never mistaken for
    // what this one applied.
    owned.schema = `release_${randomBytes(4).toString('hex')}`
    const check = await runInConsumerProject(project, {
      script: 'release-conformance.mjs',
      args: [owned.schema],
      values: { DATABASE_URL: databaseUrl },
      timeout: CHECK_DEADLINE,
    })
    if (check.note !== '') process.stderr.write(`${check.note}\n`)
    if (!check.ok) return 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`)
    return 1
  } finally {
    await releaseWhatThisRunOwns()
  }

  // A run that could not remove what it created left a database dirty, whatever the suites said.
  if (owned.leftover) return 1

  if (hashFile(tarball) !== before) {
    process.stdout.write('the tarball changed while it was being verified\n')
    return 1
  }
  process.stdout.write(
    'the installed tarball applied its packaged migration to PostgreSQL and passed all ' +
      `three conformance suites with nothing skipped — from sha256 ${before}\n`,
  )
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  // The check itself broke; it must still clean up.
  process.stderr.write(
    `the release check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`,
  )
  await releaseWhatThisRunOwns()
  process.exitCode = 1
}
