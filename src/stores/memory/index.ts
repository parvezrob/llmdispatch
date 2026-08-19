/**
 * The in-memory store pair: everything a switch needs to run without a database.
 *
 * State lives in the process, so it is for development, tests and single-process tools —
 * two processes do not share a quota, and nothing survives a restart.
 *
 * @module
 */

import type { QuotaKey, StorePair } from '../../types'
import type { SettlementRecord, UsageInspection } from './usage-store'
import { createMemoryConfigStore } from './config-store'
import { createMemoryUsageStore } from './usage-store'

/** The lease `memoryStores()` uses, matching the PostgreSQL store's default (spec §4). */
const DEFAULT_LEASE_MS = 120_000

const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 600_000

/** The clock and lease the internal factory accepts; `memoryStores()` takes neither (§6). */
export interface MemoryStoreOptions {
  now?: () => Date
  leaseMs?: number
}

/** The test controls the store pair exposes to the conformance runners (spec §6b). */
export interface MemoryStoreControls {
  setTime: (date: Date) => Promise<void>
  reset: () => Promise<void>
  readSettled: (reservationId: string) => Promise<SettlementRecord | null>
  seedRaw: (operation: string, value: unknown) => Promise<void>
  inspect: (key: QuotaKey, day: string) => Promise<UsageInspection>
}

/** A store pair with its controls, as the internal factory builds it. */
export interface MemoryStores {
  stores: StorePair
  controls: MemoryStoreControls
}

/**
 * The store clock: real time, or the instant a control pinned it to.
 *
 * A pinned clock never moves backwards, since the reservation fence (§4) reads "already
 * expired" off it and an answer that flipped back would stop being final.
 */
function createClock(now: (() => Date) | undefined) {
  let pinned: number | null = null
  return {
    now: () => (pinned === null ? (now?.() ?? new Date()) : new Date(pinned)),
    setTime(date: Date) {
      const at = date.getTime()
      if (Number.isNaN(at)) throw new RangeError('setTime needs a valid date')
      if (pinned !== null && at < pinned) {
        throw new RangeError('setTime must not move the store clock backwards before reset')
      }
      pinned = at
    },
    unpin() {
      pinned = null
    },
  }
}

/** Rejects a lease the PostgreSQL store could not accept either, naming the option. */
function checkLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new RangeError(
      `leaseMs must be a safe integer between ${String(MIN_LEASE_MS)} and ${String(MAX_LEASE_MS)}`,
    )
  }
}

/**
 * Builds an in-memory store pair with its test controls.
 *
 * @param options `now` replaces the clock; `leaseMs` the reservation lease.
 * @throws `RangeError` when `leaseMs` is outside 5 000–600 000.
 */
export function createMemoryStores(options: MemoryStoreOptions): MemoryStores {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  checkLeaseMs(leaseMs)
  const clock = createClock(options.now)
  const usage = createMemoryUsageStore({ now: clock.now, leaseMs })
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
