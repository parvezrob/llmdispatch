/**
 * The in-memory store pair: everything a switch needs to run without a database.
 *
 * State lives in the process, so it is for development, tests and single-process tools,
 * two processes do not share a quota, and nothing survives a restart.
 *
 * @module
 */

import type { StorePair } from '../../types'
import type { InternalStores } from '../shared/controls'
import { createStoreClock } from '../shared/clock'
import { DEFAULT_LEASE_MS, assertLeaseMs } from '../shared/lease'
import { createMemoryConfigStore } from './config-store'
import { createMemoryUsageStore } from './usage-store'

/** The clock and lease the internal factory accepts; `memoryStores()` takes neither (§6). */
export interface MemoryStoreOptions {
  now?: () => Date
  leaseMs?: number
}

/**
 * Builds an in-memory store pair with its test controls.
 *
 * @param options `now` replaces the clock; `leaseMs` the reservation lease.
 * @throws `RangeError` when `leaseMs` is outside 5 000–600 000.
 */
export function createMemoryStores(options: MemoryStoreOptions): InternalStores {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  assertLeaseMs(leaseMs)
  const clock = createStoreClock(options.now)
  // Nothing pinned and no clock supplied means real time here; the PostgreSQL store leaves
  // that case to the database instead.
  const usage = createMemoryUsageStore({ now: () => clock.at() ?? new Date(), leaseMs })
  const config = createMemoryConfigStore()

  return {
    stores: { config: config.store, usage: usage.store },
    controls: {
      setTime: (date) =>
        Promise.resolve().then(() => {
          clock.setTime(date)
        }),
      reset: () =>
        Promise.resolve().then(() => {
          usage.reset()
          config.reset()
          clock.unpin()
        }),
      readSettled: (reservationId) => Promise.resolve(usage.readSettled(reservationId)),
      seedRaw: (operation, value) =>
        Promise.resolve().then(() => {
          config.seedRaw(operation, value)
        }),
      inspect: (key, day) => Promise.resolve(usage.inspect(key, day)),
    },
  }
}

/**
 * Builds the in-memory config and usage stores (spec §6).
 *
 * State is held in this instance alone: not shared, lost on restart, never pruned.
 *
 * @example
 * ```ts
 * const stores = memoryStores()
 * ```
 */
export function memoryStores(): StorePair {
  return createMemoryStores({}).stores
}
