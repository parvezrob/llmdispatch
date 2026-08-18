/**
 * Root entry point — `import { … } from 'llmswitch'`.
 *
 * This is the only module that assembles the pieces: it will export the factory that
 * turns providers, operation definitions and stores into a working switch, the
 * built-in provider adapters, the in-memory stores, the error type every failed run
 * raises, and the types describing all of them.
 *
 * The exact surface is specified in `docs/spec.md` §6. Nothing is exported yet — the
 * package is pre-release and the implementation lands before the first publish.
 *
 * @module
 */

export {}
