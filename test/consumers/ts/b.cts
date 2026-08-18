// A CommonJS module: TypeScript must reach the `require` declarations of every entry point.
import root = require('llmswitch')
import postgres = require('llmswitch/postgres')
import conformance = require('llmswitch/conformance')

export const reached = [root, postgres, conformance].length
