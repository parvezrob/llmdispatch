/**
 * Conformance entry point — `import { … } from 'llmswitch/conformance'`.
 *
 * For anyone writing their own usage store, config store or provider adapter: the harnesses
 * check an implementation against the behaviour the rest of the package relies on, so a store
 * or adapter that passes is substitutable for a built-in one. They need no test framework —
 * each one resolves with a plain result you can assert on however you like.
 *
 * The exact surface is specified in `docs/spec.md` §6b and §8. The provider harness is still
 * to come; the package is pre-release and it lands before the first publish.
 *
 * @module
 */

export type { ConformanceResult } from './conformance/result'
export { runConfigStoreConformance } from './conformance/config-store'
export { runUsageStoreConformance } from './conformance/usage-store'
