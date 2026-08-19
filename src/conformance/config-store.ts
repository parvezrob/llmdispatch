/**
 * The config-store conformance suite: one case per behaviour spec §8 requires of a route store.
 *
 * A config store is judged on fidelity alone. Whether a row means anything is the core's
 * question, so every case here asks only whether what was written comes back unchanged.
 *
 * @module
 */

import type { ConfigStore, OperationRoute } from '../types'
import type { ConformanceCase, ConformanceResult } from './result'
import { rejects, runCases } from './result'

/** What `create()` hands over, named once so the cases can be typed. */
interface ConfigControls {
  store: ConfigStore
  reset(): Promise<void>
  seedRaw(operation: string, value: unknown): Promise<void>
}

const OPERATION = 'conformance'

/** A route using every field, so nothing can be dropped unnoticed. */
function route(): OperationRoute {
  return {
    provider: 'conformance-provider',
    model: 'conformance-model',
    maxOutputTokens: 1024,
    temperature: 0.2,
    quota: { perDay: 25 },
    fallback: {
      provider: 'conformance-provider',
      model: 'conformance-fallback',
      maxOutputTokens: 512,
      temperature: 0.7,
    },
  }
}

/** What one operation holds, or `undefined` when the store has no row for it. */
async function stored(store: ConfigStore, operation: string): Promise<unknown> {
  const all = await store.getAll()
  return Object.hasOwn(all, operation) ? all[operation] : undefined
}

const CASES: readonly ConformanceCase<ConfigControls>[] = [
  {
    name: 'set-get-round-trip',
    async run({ store }, expect) {
      await store.set(OPERATION, route())
      expect.equal(await stored(store, OPERATION), route(), 'the route read back')
    },
  },
  {
    name: 'delete-removes-row',
    async run({ store }, expect) {
      await store.set(OPERATION, route())
      await store.set('conformance-other', { ...route(), model: 'model-for-the-other' })
      await store.delete(OPERATION)

      const all = await store.getAll()
      expect.that(
        !Object.hasOwn(all, OPERATION),
        'a deleted operation to be gone',
        'it was still there',
      )
      expect.equal(
        await stored(store, 'conformance-other'),
        { ...route(), model: 'model-for-the-other' },
        'the row that was not deleted',
      )
    },
  },
  {
    name: 'seed-raw-returned-verbatim',
    async run(controls, expect) {
      const rows = {
        'raw-string': 'not a route',
        'raw-number': 7,
        'raw-null': null,
        'raw-wrong-type': { provider: 'conformance-provider', model: 42 },
      }
      for (const [operation, value] of Object.entries(rows)) {
        await controls.seedRaw(operation, value)
      }
      for (const [operation, value] of Object.entries(rows)) {
        expect.equal(await stored(controls.store, operation), value, `the row for ${operation}`)
      }
    },
  },
  {
    name: 'read-your-writes',
    async run({ store }, expect) {
      await store.set(OPERATION, route())
      expect.equal(
        await stored(store, OPERATION),
        route(),
        'the route read straight after a set',
      )
      const replacement = { ...route(), model: 'conformance-replacement' }
      await store.set(OPERATION, replacement)
      expect.equal(
        await stored(store, OPERATION),
        replacement,
        'the route read after a rewrite',
      )
    },
  },
  {
    name: 'quota-field-verbatim',
    async run({ store }, expect) {
      await store.set(OPERATION, { provider: 'p', model: 'm', quota: { perDay: 3 } })
      expect.equal(
        await stored(store, OPERATION),
        { provider: 'p', model: 'm', quota: { perDay: 3 } },
        'a route carrying a quota',
      )
    },
  },
  {
    name: 'special-operation-names',
    async run({ store }, expect) {
      const names = ['', '__proto__', 'constructor', 'toString']
      for (const name of names) {
        await store.set(name, { ...route(), model: `model-for-${name}` })
      }
      const all = await store.getAll()
      for (const name of names) {
        expect.that(
          Object.hasOwn(all, name),
          `an operation named '${name}' to come back as an own key`,
          'it did not',
        )
        expect.equal(
          Object.hasOwn(all, name) ? all[name] : undefined,
          { ...route(), model: `model-for-${name}` },
          `the route stored under '${name}'`,
        )
      }
    },
  },
  {
    name: 'long-operation-names-distinct',
    async run({ store }, expect) {
      // 1 000 bytes of UTF-8 is the longest name the contract requires a store to hold, and
      // two that differ only in their last character must not become one row.
      const prefix = '\u20ac'.repeat(333)
      const first = `${prefix}a`
      const second = `${prefix}b`
      await store.set(first, { ...route(), model: 'model-for-the-first' })
      await store.set(second, { ...route(), model: 'model-for-the-second' })

      const all = await store.getAll()
      expect.equal(Object.keys(all).length, 2, 'the number of rows two long names produce')
      expect.equal(
        await stored(store, first),
        { ...route(), model: 'model-for-the-first' },
        'the route stored under the first long name',
      )
      expect.equal(
        await stored(store, second),
        { ...route(), model: 'model-for-the-second' },
        'the route stored under the second long name',
      )
    },
  },
  {
    name: 'returned-values-detached',
    async run({ store }, expect) {
      const written = route()
      await store.set(OPERATION, written)
      written.model = 'edited-after-set'
      if (written.fallback) written.fallback.model = 'edited-after-set'
      if (written.quota) written.quota.perDay = 9_999
      expect.equal(
        await stored(store, OPERATION),
        route(),
        'the stored route after the caller edited what it passed in, nested fields and all',
      )

      const all = await store.getAll()
      const value = all[OPERATION]
      if (typeof value === 'object' && value !== null) {
        // The store returned an object; editing it must not reach what the store holds.
        const read = value as Record<string, unknown>
        read.model = 'edited-after-read'
        const fallback = read.fallback
        if (typeof fallback === 'object' && fallback !== null) {
          ;(fallback as Record<string, unknown>).model = 'edited-after-read'
        }
        const quota = read.quota
        if (typeof quota === 'object' && quota !== null) {
          ;(quota as Record<string, unknown>).perDay = 9_999
        }
      }
      expect.equal(
        await stored(store, OPERATION),
        route(),
        'the stored route after the caller edited what it read, nested fields and all',
      )
    },
  },
  {
    name: 'rejects-out-of-domain-strings',
    async run({ store }, expect) {
      // Spec §6: well-formed Unicode, no U+0000, at most 1 000 bytes of UTF-8.
      const nul = 'a\u0000b'
      const fallback = { provider: 'conformance-provider', model: 'conformance-fallback' }
      const persisted = [
        { field: 'an operation name', call: () => store.set(nul, route()) },
        {
          field: "a route's provider",
          call: () => store.set(OPERATION, { ...route(), provider: nul }),
        },
        {
          field: "a route's model",
          call: () => store.set(OPERATION, { ...route(), model: nul }),
        },
        {
          field: "a fallback's provider",
          call: () =>
            store.set(OPERATION, { ...route(), fallback: { ...fallback, provider: nul } }),
        },
        {
          field: "a fallback's model",
          call: () =>
            store.set(OPERATION, { ...route(), fallback: { ...fallback, model: nul } }),
        },
      ]
      for (const { field, call } of persisted) {
        await rejects(call, expect, `${field} holding U+0000`)
      }

      // The whole rule, on one field: a lone surrogate and a byte too many are refused as well.
      for (const value of [nul, 'a\ud800b', `${'\u20ac'.repeat(333)}ab`]) {
        await rejects(
          () => store.set(OPERATION, { ...route(), provider: value }),
          expect,
          `a route whose provider is ${JSON.stringify(value)}`,
        )
      }
      const longest = `${'\u20ac'.repeat(333)}a`
      await store.set(OPERATION, { ...route(), provider: longest })
      expect.equal(
        await stored(store, OPERATION),
        { ...route(), provider: longest },
        'a route whose provider is exactly 1 000 bytes',
      )
    },
  },
]

/**
 * Checks a `ConfigStore` against the behaviour spec §8 requires of one.
 *
 * Framework-free: call it from any test runner or from a script, and read the result. Every
 * case starts from `reset()`, so the verdict does not depend on the order anything ran in.
 *
 * @param opts `create` builds the store under test, plus `seedRaw` for writing rows no
 *   `set` would produce.
 * @returns Every failure, each prefixed with the case that reported it.
 *
 * @example
 * ```ts
 * const result = await runConfigStoreConformance({ create: () => buildMyStore() })
 * if (!result.passed) throw new Error(result.failures.join('\n'))
 * ```
 */
export function runConfigStoreConformance(opts: {
  create(): Promise<{
    store: ConfigStore
    reset(): Promise<void>
    seedRaw(operation: string, value: unknown): Promise<void>
  }>
}): Promise<ConformanceResult> {
  return runCases(
    () => opts.create(),
    (controls) => controls.reset(),
    CASES,
  )
}
