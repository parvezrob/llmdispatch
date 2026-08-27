// Reaches every advertised entry point the way an ESM application does, then checks the one
// thing only an installed package can check: an error thrown by the ESM build is recognised
// by the CommonJS build, and the other way round. That is the dual-package hazard, and it is
// why recognition is brand-based rather than `instanceof`.
import { createRequire } from 'node:module'

import * as conformance from 'llmdispatch/conformance'
import * as postgres from 'llmdispatch/postgres'
import * as root from 'llmdispatch'

const requireFromHere = createRequire(import.meta.url)
const commonjs = requireFromHere('llmdispatch')

for (const [name, entry] of Object.entries({ root, postgres, conformance })) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`import of ${name} did not produce a module namespace`)
  }
}

/** Fails the fixture with the claim that did not hold. */
function check(claim, held) {
  if (!held) throw new Error(claim)
}

const fromEsm = new root.ProviderError('rate_limit', { status: 429 })
const fromCjs = new commonjs.ProviderError('auth', { status: 401 })

check(
  'the two builds turned out to be the same class, so this proves nothing',
  root.ProviderError !== commonjs.ProviderError,
)
check(
  'bare instanceof already recognised it, so this proves nothing',
  !(fromCjs instanceof root.ProviderError),
)
check(
  'the CommonJS build did not recognise an error from the ESM build',
  commonjs.ProviderError.is(fromEsm),
)
check(
  'the ESM build did not recognise an error from the CommonJS build',
  root.ProviderError.is(fromCjs),
)

for (const value of [
  undefined,
  null,
  0,
  'transient',
  new Error('failed'),
  { kind: 'transient' },
]) {
  check(`${String(value)} was mistaken for a provider error`, !root.ProviderError.is(value))
}

const forged = {
  [Symbol.for('llmdispatch.ProviderError')]: true,
  kind: 'overloaded',
  message: 'x',
}
check(
  'an object carrying the brand with an unknown kind was accepted',
  !root.ProviderError.is(forged),
)

console.log('esm consumer reached all three entry points and recognised errors across builds')

// The in-memory stores, reached from the installed package: a reservation is admitted,
// committed, counted and settled, and the day's only slot is then gone.
const stores = root.memoryStores()
const key = { operation: 'summarize', subjectId: 'user-1' }
const attempt = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  outcome: 'succeeded',
  usage: { inputTokens: 12, outputTokens: 34 },
  costUsd: null,
  durationMs: 120,
}

const reserved = await stores.usage.reserve(key, 1)
check('the in-memory store denied the first reservation of the day', reserved.ok)
check(
  'committing a live reservation did not answer committed',
  (await stores.usage.commit(reserved.reservation.reservationId)) === 'committed',
)
await stores.usage.settle(reserved.reservation, 'succeeded', [attempt])
check('the committed slot was not counted', (await stores.usage.snapshot(key)).used === 1)
check(
  'the day admitted a second reservation at a limit of one',
  !(await stores.usage.reserve(key, 1)).ok,
)

await stores.config.set('summarize', { provider: 'claude', model: 'claude-sonnet-4-6' })
check(
  'the config store did not return the route it was given',
  (await stores.config.getAll()).summarize.model === 'claude-sonnet-4-6',
)

console.log('esm consumer round-tripped a reservation through the in-memory stores')

// The core pipeline end to end, from the installed package: an in-fixture provider, a
// declared operation, and a run that parses, validates and counts against a quota. The
// other build's createSwitch is checked too — both module systems reach the same factory.
const { z } = await import('zod')
check(
  'the CommonJS build does not export createSwitch',
  typeof commonjs.createSwitch === 'function',
)
const ai = root.createSwitch({
  providers: {
    fixture: {
      complete: (request) =>
        Promise.resolve({
          kind: 'complete',
          text: JSON.stringify({ echoed: request.prompt }),
          usage: { inputTokens: 1, outputTokens: 2 },
        }),
    },
  },
  operations: root.defineOperations({
    echo: root.defineOperation({
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
      prompt: ({ text }) => `say ${text}`,
      quota: { perDay: 2 },
      defaultRoute: { provider: 'fixture', model: 'm' },
    }),
  }),
  stores: root.memoryStores(),
})
const run = await ai.run('echo', { input: { text: 'hello' }, subjectId: 'consumer' })
check('the run did not build and echo the prompt', run.data.echoed === 'say hello')
check(
  'the run misreported its route',
  run.route.provider === 'fixture' && run.usedFallback === false,
)
check(
  'usage was not aggregated from the attempt',
  run.usage.inputTokens === 1 && run.usage.outputTokens === 2 && run.usageComplete,
)
check('the committed run was not counted', (await ai.getQuota('echo', 'consumer')).used === 1)
console.log('esm consumer ran an operation end to end through createSwitch')

// The packaged migration, from the subpath: the hash the two builds render has to be the same
// one, or an adopter's ESM and CommonJS code would disagree about which schema they applied.
const migration = postgres.migrationSql()
check(
  'the migration still carries its schema placeholder',
  !migration.sql.includes('__SCHEMA__'),
)
console.log(`esm consumer migration sha256 ${migration.sha256}`)
