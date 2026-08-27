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
 * The suites import the package, so what they exercise is its ESM build. The CommonJS build is
 * not this check's subject: the workflow's consumer-fixture job installs the same audited
 * tarball into a `require`-shaped project and reaches every entry point from there.
 *
 * The database must be a throwaway on this machine. The migration creates and drops a schema,
 * and the store suites write and truncate; nothing about the run is safe to point at a
 * database anyone else is using, so the connection string is held to a literal IPv4 loopback
 * address with an explicit port, and refused if it carries a query or a fragment — several
 * parameters decide where a connection actually goes, and a fragment hides them from a parser
 * (see `lib/database-target.mjs`).
 *
 * The schema belongs to this process, not to the runner it starts. A runner that is killed
 * cannot tidy up after itself, so the schema is dropped from here on every path there is —
 * a pass, a failure, an exception, a deadline, or an interrupt.
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
 * The image is pinned by digest rather than by tag so two runs a month apart are the same
 * check. Exit codes: 0 verified, 1 a check failed, 2 wrong usage or a missing database.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import pg from 'pg'

import {
  createConsumerProject,
  pinnedDevelopmentVersion,
  runInConsumerProject,
} from './lib/consumer-project.mjs'
import { describeUnusableDatabase } from './lib/database-target.mjs'
import { hashFile } from './lib/installed-package.mjs'

const USAGE = 'usage: verify-release.mjs <path-to-tgz>\n'
const RUNNER = join(import.meta.dirname, 'runners', 'release-conformance.mjs')
const TEMPLATE = join(import.meta.dirname, 'fixtures', 'openai-chat-completion.json')

/** Long enough for the suites on a cold database, short enough that a hang is a failure. */
const CHECK_DEADLINE = 10 * 60_000
/** Dropping one schema is one statement; longer than this means nothing is coming back. */
const CLEANUP_DEADLINE = 30_000

/**
 * What this run has created and is therefore responsible for removing.
 *
 * @type {{
 *   workspace: string | null
 *   schema: string | null
 *   databaseUrl: string | null
 * }}
 */
const owned = { workspace: null, schema: null, databaseUrl: null }

/** The clean-up already under way, so a second caller waits for it instead of starting one. */
let releasing = null

/**
 * Drops the schema this run created and removes its workspace, once.
 *
 * Both are safe to attempt when they were never created, which is what makes this callable
 * from a signal handler as well as from the end of a run.
 *
 * It hands back a promise rather than setting a flag that says "already done", and that
 * matters: an interrupt arriving while the normal path is halfway through the drop has to
 * wait for that drop, not see a flag, decide there is nothing to do, and exit the process out
 * from under it.
 */
function releaseWhatThisRunOwns() {
  releasing ??= release()
  return releasing
}

/**
 * The clean-up itself. Called once; everything else waits on the promise it returned.
 *
 * A schema that will not drop is named out loud, with the statement that removes it: it is the
 * one leftover a person has to deal with by hand, and a run that hid it would be leaving a
 * database dirty in silence.
 */
async function release() {
  if (owned.schema !== null && owned.databaseUrl !== null) {
    const pool = new pg.Pool({
      connectionString: owned.databaseUrl,
      connectionTimeoutMillis: CLEANUP_DEADLINE,
    })
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${owned.schema}" CASCADE`)
    } catch {
      process.stderr.write(
        `the schema ${owned.schema} could not be dropped. If the run reached the database, ` +
          `it is still there — remove it with: DROP SCHEMA IF EXISTS "${owned.schema}" CASCADE\n`,
      )
    } finally {
      await pool.end().catch(() => undefined)
    }
  }
  if (owned.workspace !== null) {
    // Caught for the same reason the drop above is: this runs from a signal handler and from
    // the top-level catch, and it is the memoised promise everything else waits on. A throw
    // here would reach nobody as a rejection and would take the messages above with it.
    try {
      rmSync(owned.workspace, { recursive: true, force: true })
    } catch {
      process.stderr.write(`the directory ${owned.workspace} could not be removed\n`)
    }
  }
}

/** Cleans up and stops when this process is interrupted, rather than leaving a schema behind. */
function cleanUpOnSignal() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\nstopped by ${signal}; cleaning up\n`)
      void releaseWhatThisRunOwns().finally(() => {
        // A handler replaces the default disposition, so the exit has to be explicit; the
        // code says the run proved nothing, which is what a stopped check did.
        process.exit(1)
      })
    })
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

  const before = hashFile(tarball)
  cleanUpOnSignal()
  owned.databaseUrl = databaseUrl
  owned.workspace = mkdtempSync(join(tmpdir(), 'llmswitch-release-'))
  try {
    const project = createConsumerProject({
      workspace: owned.workspace,
      name: 'consumer',
      tarballPath: tarball,
      // The peer the package declares, and the driver it deliberately does not ship: a
      // project that installs llmswitch has to bring both, so this one does too.
      // `pg-connection-string` is pinned by name as well, though `pg` would bring it along
      // anyway: it is what the guard above read the connection target out of, and the version
      // that decided a string was safe should be the version that then connects with it.
      packages: [
        pinnedDevelopmentVersion('zod'),
        pinnedDevelopmentVersion('pg'),
        pinnedDevelopmentVersion('pg-connection-string'),
      ],
      files: [RUNNER, TEMPLATE],
    })

    // A schema of this run's own, so a leftover from an interrupted run cannot be mistaken
    // for what this one applied.
    owned.schema = `release_${randomBytes(4).toString('hex')}`
    const check = runInConsumerProject(project, {
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
  // Nothing below main() is meant to throw, so this is the path where the check itself broke.
  // It still has to clean up: an unhandled failure is exactly when a schema gets left behind.
  process.stderr.write(
    `the release check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`,
  )
  await releaseWhatThisRunOwns()
  process.exitCode = 1
}
