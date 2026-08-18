// Reaches every advertised entry point the way a CommonJS application does.
const conformance = require('llmswitch/conformance')
const postgres = require('llmswitch/postgres')
const root = require('llmswitch')

for (const [name, entry] of Object.entries({ root, postgres, conformance })) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`require of ${name} did not produce an object`)
  }
}

console.log('cjs consumer reached all three entry points')
