// An ES module: TypeScript must reach the `import` declarations of every entry point.
import * as conformance from 'llmswitch/conformance'
import * as postgres from 'llmswitch/postgres'
import * as root from 'llmswitch'

export const reached = [root, postgres, conformance].length
