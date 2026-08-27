#!/usr/bin/env node
/**
 * The release check itself, executed from inside the scratch project that installed the
 * tarball. It is copied there rather than run from the repository, so what it resolves is the
 * installed package (see `subpath-resolution`).
 *
 * In order: confirm every published subpath resolves to the installed package, apply the
 * packaged migration to the given schema, run the two store conformance suites against the
 * installed PostgreSQL stores, and run the provider suite against a fixture backend served
 * from this process.
 *
 * The schema is named by the caller, which also drops it: this process can be killed and so
 * cannot be relied on to clean up after itself.
 *
 * Usage: node release-conformance.mjs <schema>
 * Needs `DATABASE_URL`. Exit codes: 0 everything passed, 1 something did not.
 *
 * @module
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { assertInstalledPackageResolves } from './subpath-resolution.mjs'

/** The template the fixture backend answers from, copied in beside this runner. */
const TEMPLATE = join(import.meta.dirname, 'openai-chat-completion.json')
/** Not a key and not shaped like one: the fixture only checks that it arrives verbatim. */
const FIXTURE_KEY = 'fixture-credential-for-the-release-check'

/* ------------------------------------------------------------------ the guard ---- */

/**
 * Everything the three subpaths export, filled in once the guard has said where they came
 * from. Nothing below runs before that, so a runner that ended up beside the wrong package
 * reports which file it would have imported instead of a stack from importing it.
 */
let installed = null

/** Imports all three subpaths. Only ever called after `assertInstalledPackageResolves`. */
async function importInstalledPackage() {
  return {
    package: await import('llmdispatch'),
    postgres: await import('llmdispatch/postgres'),
    conformance: await import('llmdispatch/conformance'),
  }
}

/* ---------------------------------------------------------------- the fixture ---- */

/**
 * The provider backend, driven scenario by scenario.
 *
 * The provider suite puts the backend into a named condition and then dispatches; this server
 * is that backend. Every classification row the built-in adapter documents is covered here, so
 * the suite reports nothing as unverified: a release must not ship on a partial answer.
 */
function renderScenario(template, scenario) {
  const body = structuredClone(template)
  switch (scenario) {
    case 'success':
      body.choices[0].message.content = JSON.stringify({ ok: true })
      return { status: 200, body }
    case 'truncated':
      body.choices[0].message.content = 'partial'
      body.choices[0].finish_reason = 'length'
      return { status: 200, body }
    case 'refused':
      body.choices[0].message.refusal = 'the backend declined this request'
      return { status: 200, body }
    case 'malformed_response':
      body.choices[0].finish_reason = 'a reason no adapter maps'
      return { status: 200, body }
    case 'auth':
      return { status: 401, body: { error: { message: 'unauthorized' } } }
    case 'rate_limit':
      return { status: 429, body: { error: { message: 'slow down' } } }
    case 'model_not_found':
      return { status: 404, body: { error: { message: 'no such model' } } }
    case 'invalid_request':
      return { status: 422, body: { error: { message: 'unprocessable' } } }
    case 'transient':
      return { status: 503, body: { error: { message: 'unavailable' } } }
    default:
      return { status: 500, body: { error: { message: `unknown scenario ${scenario}` } } }
  }
}

/** Why a call is not one this check expects, or `null` when it is. */
function describeUnexpected(request, rawBody, model) {
  if (request.method !== 'POST') return `method ${String(request.method)}`
  if (request.url !== '/v1/chat/completions') return `path ${String(request.url)}`
  if (request.headers.authorization !== `Bearer ${FIXTURE_KEY}`) return 'credential'
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return 'body is not JSON'
  }
  if (body?.model !== model) return `model ${String(body?.model)}`
  return null
}

function startFixture(state) {
  return new Promise((ready, failed) => {
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const problem = describeUnexpected(
          request,
          Buffer.concat(chunks).toString('utf8'),
          state.model,
        )
        if (problem !== null) state.unexpected.push(problem)
        const answer = renderScenario(state.template, state.scenario)
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.body))
      })
    })
    server.on('error', failed)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      ready({
        server,
        port: typeof address === 'object' && address !== null ? address.port : 0,
      })
    })
  })
}

/* ------------------------------------------------------------------ the suites ---- */

/** The control statements the suites need, which no store method sends. */
function controlStatements(schema) {
  return {
    truncate: `TRUNCATE "${schema}".usage_counters, "${schema}".usage_reservations,
"${schema}".usage_settlements, "${schema}".operation_routes`,
    readSettled: `SELECT reservation_id, operation, subject_id, to_char(day, 'YYYY-MM-DD') AS day,
       outcome, attempts FROM "${schema}".usage_settlements WHERE reservation_id = $1`,
    seedRaw: `INSERT INTO "${schema}".operation_routes (operation, route) VALUES ($1, $2::jsonb)
ON CONFLICT (operation) DO UPDATE SET route = EXCLUDED.route`,
  }
}

/**
 * Runs both store suites against the installed stores, reached only through the public
 * factory and a pool of this check's own: the shape an adopter has.
 */
async function runStoreSuites(pool, schema) {
  const controls = controlStatements(schema)
  let pinned = null
  const drifted = []
  // From the installed package, not a copy: a copy would keep matching after the package had
  // changed it.
  const marker = installed.postgres.USAGE_STORE_MARKER
  // Strict: an unrecognised marker is reported rather than silently running the usage suite
  // against the database's own clock.
  const wrapper = {
    query(sql, params) {
      if (!sql.startsWith(marker)) return pool.query(sql, params)
      const supplied = [...(params ?? [])]
      if (supplied.length === 0) drifted.push('a usage statement carried no parameters')
      if (supplied.at(-1) !== null) drifted.push('a usage statement did not end with null')
      supplied[supplied.length - 1] = pinned?.toISOString() ?? null
      return pool.query(sql, supplied)
    },
  }
  const stores = installed.package.postgresStores({ pool: wrapper, schema })

  const usage = await installed.conformance.runUsageStoreConformance({
    create: () =>
      Promise.resolve({
        store: stores.usage,
        setTime: (date) => {
          pinned = date
          return Promise.resolve()
        },
        reset: async () => {
          pinned = null
          await pool.query(controls.truncate)
        },
        readSettled: async (reservationId) => {
          const { rows } = await pool.query(controls.readSettled, [reservationId])
          const [row] = rows
          return row === undefined
            ? null
            : {
                reservation: {
                  reservationId: row.reservation_id,
                  key: { operation: row.operation, subjectId: row.subject_id },
                  day: row.day,
                },
                outcome: row.outcome,
                attempts: row.attempts,
              }
        },
      }),
  })

  const config = await installed.conformance.runConfigStoreConformance({
    create: () =>
      Promise.resolve({
        store: stores.config,
        reset: () => pool.query(controls.truncate).then(() => undefined),
        seedRaw: (operation, value) =>
          pool
            .query(controls.seedRaw, [operation, JSON.stringify(value)])
            .then(() => undefined),
      }),
  })

  return { usage, config, drifted }
}

/** Runs the provider suite against the fixture backend, every scenario supplied. */
async function runProviderSuite(state, port) {
  const provider = installed.package.openaiCompatible({
    apiKey: () => Promise.resolve(FIXTURE_KEY),
    // Concatenated, not interpolated: an interpolation mid-link leaves the denylist scanner a
    // token it cannot parse.
    baseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
    // The fixture answers JSON on the success path, so the adapter is held to the native duty
    // rather than skipped as unverified.
    jsonMode: 'native',
  })
  const enter = (scenario) => () => {
    state.scenario = scenario
    return Promise.resolve()
  }
  return installed.conformance.runProviderConformance({
    provider,
    requestFactory: () => ({
      prompt: 'reply with {"ok":true}',
      // The model the fixture's recorded response names; anything else and the backend would
      // answer with a body claiming to be a different model.
      model: state.model,
      responseFormat: { type: 'text' },
      maxOutputTokens: 16,
      signal: new AbortController().signal,
    }),
    scenarios: {
      success: enter('success'),
      auth: enter('auth'),
      rate_limit: enter('rate_limit'),
      model_not_found: enter('model_not_found'),
      invalid_request: enter('invalid_request'),
      transient: enter('transient'),
      malformed_response: enter('malformed_response'),
      truncated: enter('truncated'),
      refused: enter('refused'),
    },
    controls: { jsonCapability: 'native' },
  })
}

/* ----------------------------------------------------------------------- main ---- */

/** A suite's verdict as a line, and its failures. Skips count against a release too. */
function report(name, result, problems) {
  for (const failure of result.failures) problems.push(`${name}: ${failure}`)
  for (const skip of result.skipped) {
    problems.push(`${name}: '${skip}' was skipped, so it is unverified`)
  }
  if (result.failures.length > 0 || result.skipped.length > 0) return
  // `passed` is the suite's verdict; empty lists are only this side's reading of it.
  if (result.passed !== true) {
    problems.push(`${name}: reported not passed without naming a failure`)
    return
  }
  process.stdout.write(`${name}: passed, nothing skipped\n`)
}

/**
 * Releases the pool and the listening socket when this process is asked to stop, so it is not
 * holding a connection to the schema its caller is about to drop. The schema is the caller's.
 */
function closeOnSignal(fixture, pool) {
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      process.stderr.write(`the release check was stopped by ${signal}\n`)
      fixture.server.close()
      void pool.end().catch(() => undefined)
      // A handler replaces the default disposition, so the exit must be explicit.
      process.exit(1)
    })
  }
}

async function main() {
  const [schema] = process.argv.slice(2)
  if (schema === undefined) {
    process.stderr.write('usage: release-conformance.mjs <schema>\n')
    return 2
  }
  const url = process.env.DATABASE_URL ?? ''
  if (url === '') {
    process.stderr.write('DATABASE_URL is not set\n')
    return 2
  }

  try {
    for (const { subpath, file } of assertInstalledPackageResolves()) {
      process.stdout.write(`resolved ${subpath} -> ${file}\n`)
    }
  } catch (error) {
    // Said in full: the guard reports file paths and nothing else, and a run that would have
    // imported the wrong package is worth naming precisely.
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown failure'}\n`)
    return 1
  }
  installed = await importInstalledPackage()
  if (typeof installed.postgres.USAGE_STORE_MARKER !== 'string') {
    process.stderr.write('the installed package publishes no USAGE_STORE_MARKER\n')
    return 1
  }

  const problems = []
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const state = {
    template,
    // Read off the fixture rather than written down twice.
    model: template.model,
    scenario: 'success',
    unexpected: [],
  }
  if (typeof state.model !== 'string' || state.model === '') {
    process.stderr.write('the fixture response names no model\n')
    return 1
  }
  const fixture = await startFixture(state)
  const pool = new pg.Pool({ connectionString: url })
  closeOnSignal(fixture, pool)
  try {
    const migration = installed.postgres.migrationSql({ schema })
    process.stdout.write(`migration sha256 ${migration.sha256}, schema ${schema}\n`)
    await pool.query(migration.sql)

    const stores = await runStoreSuites(pool, schema)
    for (const drift of stores.drifted) problems.push(`the usage store: ${drift}`)
    report('the usage store suite', stores.usage, problems)
    report('the config store suite', stores.config, problems)

    const provider = await runProviderSuite(state, fixture.port)
    report('the provider suite', provider, problems)
    for (const unexpected of state.unexpected) {
      problems.push(`the fixture refused a provider call: ${unexpected}`)
    }
  } finally {
    // The schema is left standing: the caller named it and drops it.
    await pool.end().catch(() => undefined)
    await new Promise((done) => fixture.server.close(() => done(undefined)))
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  return problems.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `the release check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`,
  )
  process.exitCode = 1
}
