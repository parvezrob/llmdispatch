// Reaches every advertised entry point the way a CommonJS application does, then checks the
// same recognition claim from this side: this build's error is recognised by the ESM build,
// and the ESM build's error by this one.
const conformance = require('llmswitch/conformance')
const postgres = require('llmswitch/postgres')
const root = require('llmswitch')

for (const [name, entry] of Object.entries({ root, postgres, conformance })) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`require of ${name} did not produce an object`)
  }
}

/** Fails the fixture with the claim that did not hold. */
function check(claim, held) {
  if (!held) throw new Error(claim)
}

async function main() {
  // `import()` from CommonJS resolves the `import` condition, so this is the other build.
  const esm = await import('llmswitch')

  const fromCjs = new root.ProviderError('rate_limit', { status: 429 })
  const fromEsm = new esm.ProviderError('auth', { status: 401 })

  check(
    'the two builds turned out to be the same class, so this proves nothing',
    root.ProviderError !== esm.ProviderError,
  )
  check(
    'bare instanceof already recognised it, so this proves nothing',
    !(fromEsm instanceof root.ProviderError),
  )
  check(
    'the ESM build did not recognise an error from the CommonJS build',
    esm.ProviderError.is(fromCjs),
  )
  check(
    'the CommonJS build did not recognise an error from the ESM build',
    root.ProviderError.is(fromEsm),
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

  const brand = Symbol.for('llmswitch.ProviderError')
  check(
    'an object carrying the brand with an unknown kind was accepted',
    !root.ProviderError.is({ [brand]: true, kind: 'overloaded', message: 'x' }),
  )
  check(
    'an object carrying the brand with no message was accepted',
    !root.ProviderError.is({ [brand]: true, kind: 'auth' }),
  )

  console.log('cjs consumer reached all three entry points and recognised errors across builds')

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

  console.log('cjs consumer round-tripped a reservation through the in-memory stores')

  // The same migration, rendered by the other build.
  const migration = postgres.migrationSql()
  check(
    'the migration still carries its schema placeholder',
    !migration.sql.includes('__SCHEMA__'),
  )
  console.log(`cjs consumer migration sha256 ${migration.sha256}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
