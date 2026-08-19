/**
 * The in-process config store: routes in a map, returned exactly as they were written.
 *
 * Whether a stored row means anything is the core's question (spec §2); this store's whole
 * job is fidelity.
 *
 * @module
 */

import type { ConfigStore } from '../../types'
import { assertStoreString, validatedRoute } from '../shared/domain'
import { asPromise } from '../shared/promise'

/** The store plus the controls the conformance runner and the package's tests need. */
export interface MemoryConfigStore {
  store: ConfigStore
  reset: () => void
  seedRaw: (operation: string, value: unknown) => void
}

/** Builds an in-memory config store. */
export function createMemoryConfigStore(): MemoryConfigStore {
  const rows = new Map<string, unknown>()

  return {
    store: {
      getAll: () =>
        asPromise(() => {
          // `Object.fromEntries` defines own properties, so an operation named `__proto__` or
          // `constructor` comes back as an ordinary key rather than reaching the prototype.
          const all: Record<string, unknown> = Object.fromEntries(rows)
          return structuredClone(all)
        }),
      set: (operation, route) =>
        asPromise(() => {
          assertStoreString(operation, 'operation')
          // The checked copy is what is kept, so editing the caller's object afterwards — or
          // answering differently on a second read — cannot change what the store holds.
          rows.set(operation, validatedRoute(route))
        }),
      delete: (operation) =>
        asPromise(() => {
          assertStoreString(operation, 'operation')
          rows.delete(operation)
        }),
    },
    reset() {
      rows.clear()
    },
    seedRaw(operation, value) {
      rows.set(operation, structuredClone(value))
    },
  }
}
