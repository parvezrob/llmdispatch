/**
 * Conformance entry point — `import { … } from 'llmswitch/conformance'`.
 *
 * For anyone writing their own provider adapter, usage store or config store: it will
 * export the three harnesses that check an implementation against the behaviour the
 * rest of the package relies on, so a store or adapter that passes is substitutable
 * for a built-in one.
 *
 * The exact surface is specified in `docs/spec.md` §6b and §8. Nothing is exported yet
 * — the package is pre-release and the implementation lands before the first publish.
 *
 * @module
 */

export {}
