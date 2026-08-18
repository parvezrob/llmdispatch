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
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
