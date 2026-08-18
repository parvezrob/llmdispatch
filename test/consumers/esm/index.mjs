// Reaches every advertised entry point the way an ESM application does.
import * as conformance from 'llmswitch/conformance'
import * as postgres from 'llmswitch/postgres'
import * as root from 'llmswitch'

for (const [name, entry] of Object.entries({ root, postgres, conformance })) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`import of ${name} did not produce a module namespace`)
  }
}

console.log('esm consumer reached all three entry points')
