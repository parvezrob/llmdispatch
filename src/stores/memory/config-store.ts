/**
 * The in-process config store: routes in a map, returned exactly as they were written.
 *
 * Whether a stored row means anything is the core's question (spec §2); this store's whole
 * job is fidelity.
 *
 * @module
 */

import type { ConfigStore, OperationRoute } from '../../types'
import { assertStoreString } from '../shared/domain'
import { asPromise } from '../shared/promise'

/** The store plus the controls the conformance runner and the package's tests need. */
export interface MemoryConfigStore {
  store: ConfigStore
  reset: () => void
  seedRaw: (operation: string, value: unknown) => void
}

/** Every string of a route a store has to be able to hold. */
function assertRoute(route: OperationRoute): void {
  assertStoreString(route.provider, 'route.provider')
  assertStoreString(route.model, 'route.model')
  if (route.fallback === undefined || route.fallback === null) return
  assertStoreString(route.fallback.provider, 'route.fallback.provider')
  assertStoreString(route.fallback.model, 'route.fallback.model')
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
          assertRoute(route)
          // A copy on the way in: editing the object afterwards must not edit the store.
          rows.set(operation, structuredClone(route))
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
