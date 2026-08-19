/**
 * The in-process usage store: the quota state machine of spec §4, held in maps.
 *
 * Every method does its work synchronously, so JavaScript's single thread is the critical
 * section the PostgreSQL store gets from a row lock: a reserve reclaims, counts and inserts
 * without anything else running in between.
 *
 * @module
 */

import type { AttemptRecord, QuotaKey, ReservationEnvelope, UsageStore } from '../../types'
import { projectAttempts } from '../shared/attempts'
import { assertStoreString, isStoreString } from '../shared/domain'
import { asPromise } from '../shared/promise'
import { resetsAt, utcDay } from '../shared/time'

/** One reservation row. A lapsed row is a `pending` one whose lease has run out. */
interface Reservation {
  operation: string
  subjectId: string
  day: string
  state: 'pending' | 'committed' | 'expired'
  expiresAt: number
  /** Stamped by a commit that answered `'expired'`, which makes that answer final. */
  fencedAt: number | null
}

/** The admission counter for one key and day: committed plus pending, reclaimed rows aside. */
interface Counter {
  used: number
  lastAdmitted: boolean
}

/** What `settle` persisted, as `readSettled` reports it. */
export interface SettlementRecord {
  reservation: ReservationEnvelope
  outcome: 'succeeded' | 'failed'
  attempts: AttemptRecord[]
}

/** What the store reports about one key and day; the seam the package's own tests read. */
export interface UsageInspection {
  reservations: number
  counter: Counter | null
}

/** The store plus the controls the conformance runner and the package's tests need. */
export interface MemoryUsageStore {
  store: UsageStore
  reset: () => void
  readSettled: (reservationId: string) => SettlementRecord | null
  inspect: (key: QuotaKey, day: string) => UsageInspection
}

/** Anything held per operation, subject and day; nested rather than under one joined key. */
type ByKey<T> = Map<string, Map<string, Map<string, T>>>

/** The innermost map for a key, or `undefined` when nothing was ever written under it. */
function daysOf<T>(root: ByKey<T>, key: QuotaKey): Map<string, T> | undefined {
  return root.get(key.operation)?.get(key.subjectId)
}

/** The innermost map for a key, created on the way down. */
function ensureDaysOf<T>(root: ByKey<T>, key: QuotaKey): Map<string, T> {
  let subjects = root.get(key.operation)
  if (subjects === undefined) {
    subjects = new Map()
    root.set(key.operation, subjects)
  }
  let days = subjects.get(key.subjectId)
  if (days === undefined) {
    days = new Map()
    subjects.set(key.subjectId, days)
  }
  return days
}

/** Both strings a key is made of have to be storable before anything is written. */
function assertKey(key: QuotaKey): void {
  assertStoreString(key.operation, 'operation')
  assertStoreString(key.subjectId, 'subjectId')
}

/**
 * Builds an in-memory usage store.
 *
 * @param options `now` is the store's clock; `leaseMs` how long a reservation stays live.
 */
export function createMemoryUsageStore(options: {
  now: () => Date
  leaseMs: number
}): MemoryUsageStore {
  const reservations = new Map<string, Reservation>()
  const counters: ByKey<Counter> = new Map()
  const pending: ByKey<Set<string>> = new Map()
  const settlements = new Map<string, SettlementRecord>()

  /** The set of pending ids for a row's own key and day: the in-process pending index. */
  function pendingIdsOf(row: Reservation): Set<string> | undefined {
    return daysOf(pending, row)?.get(row.day)
  }

  /** Moves every lapsed pending row of a key and day to `expired`; answers how many. */
  function reclaim(ids: Set<string>, at: number): number {
    let freed = 0
    for (const id of ids) {
      const row = reservations.get(id)
      if (row?.state !== 'pending' || row.expiresAt > at) continue
      row.state = 'expired'
      ids.delete(id)
      freed += 1
    }
    return freed
  }

  function reserve(
    key: QuotaKey,
    limit: number,
  ):
    | { ok: true; reservation: ReservationEnvelope; expiresAt: string }
    | { ok: false; used: number; resetsAt: string } {
    assertKey(key)
    const at = options.now().getTime()
    const day = utcDay(new Date(at))
    const resets = resetsAt(day)

    const days = ensureDaysOf(pending, key)
    let ids = days.get(day)
    if (ids === undefined) {
      ids = new Set()
      days.set(day, ids)
    }
    const freed = reclaim(ids, at)

    // The counter row is written whether or not this reserve is admitted: the reclaim has to
    // be persisted, and a denial's `used` is only authoritative if it is the counter's own.
    const byDay = ensureDaysOf(counters, key)
    const counter = byDay.get(day) ?? { used: 0, lastAdmitted: false }
    byDay.set(day, counter)
    const used = counter.used - freed
    const admitted = used < limit
    counter.used = used + (admitted ? 1 : 0)
    counter.lastAdmitted = admitted
    if (!admitted) return { ok: false, used: counter.used, resetsAt: resets }

    // The global Web Crypto: no `node:crypto` import.
    let reservationId = crypto.randomUUID()
    while (reservations.has(reservationId)) reservationId = crypto.randomUUID()
    // A lease never crosses the day boundary (§4).
    const expiresAt = Math.min(at + options.leaseMs, Date.parse(resets))
    reservations.set(reservationId, {
      operation: key.operation,
      subjectId: key.subjectId,
      day,
      state: 'pending',
      expiresAt,
      fencedAt: null,
    })
    ids.add(reservationId)
    return {
      ok: true,
      reservation: {
        reservationId,
        key: { operation: key.operation, subjectId: key.subjectId },
        day,
      },
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  function commit(reservationId: string): 'committed' | 'expired' | 'missing' {
    // An id no store could hold is one this store cannot have issued (§4: unknown → missing).
    if (!isStoreString(reservationId)) return 'missing'
    const row = reservations.get(reservationId)
    if (row === undefined) return 'missing'
    if (row.state === 'committed') return 'committed'
    if (row.state === 'expired') return 'expired'
    const at = options.now().getTime()
    if (row.fencedAt === null && row.expiresAt > at) {
      row.state = 'committed'
      // Committed rows leave the pending index: they are counted for the rest of the day and
      // no reclaim may ever hand their slot back (§4).
      pendingIdsOf(row)?.delete(reservationId)
      return 'committed'
    }
    // Fencing the row makes `'expired'` final: a retry that captured an earlier instant can
    // never commit it afterwards. The lease itself is untouched, so the next reserve reclaims
    // the row like any other lapsed one.
    row.fencedAt ??= at
    return 'expired'
  }

  function settle(
    reservation: ReservationEnvelope,
    outcome: 'succeeded' | 'failed',
    attempts: AttemptRecord[],
  ): void {
    // Checked before the settled test on purpose: a value no store could hold is refused
    // whether or not this reservation has been settled already.
    assertStoreString(reservation.reservationId, 'reservationId')
    assertStoreString(reservation.day, 'day')
    assertKey(reservation.key)
    const records = projectAttempts(attempts)
    // First write wins (§4): a later payload for a settled reservation is ignored.
    if (settlements.has(reservation.reservationId)) return
    settlements.set(reservation.reservationId, {
      reservation: {
        reservationId: reservation.reservationId,
        key: { operation: reservation.key.operation, subjectId: reservation.key.subjectId },
        day: reservation.day,
      },
      outcome,
      attempts: records,
    })
  }

  function snapshot(key: QuotaKey): { used: number; resetsAt: string } {
    assertKey(key)
    const at = options.now().getTime()
    const day = utcDay(new Date(at))
    let lapsed = 0
    for (const id of daysOf(pending, key)?.get(day) ?? []) {
      const row = reservations.get(id)
      if (row?.state === 'pending' && row.expiresAt <= at) lapsed += 1
    }
    const counter = daysOf(counters, key)?.get(day)
    // Committed plus unexpired pending (§4), read without disturbing anything.
    return { used: Math.max(0, (counter?.used ?? 0) - lapsed), resetsAt: resetsAt(day) }
  }

  return {
    store: {
      reserve: (key, limit) => asPromise(() => reserve(key, limit)),
      commit: (reservationId) => asPromise(() => commit(reservationId)),
      settle: (reservation, outcome, attempts) =>
        asPromise(() => {
          settle(reservation, outcome, attempts)
        }),
      snapshot: (key) => asPromise(() => snapshot(key)),
    },
    reset() {
      reservations.clear()
      counters.clear()
      pending.clear()
      settlements.clear()
    },
    readSettled(reservationId) {
      const record = settlements.get(reservationId)
      // A copy, so reading what was persisted can never edit it.
      return record === undefined ? null : structuredClone(record)
    },
    inspect(key, day) {
      let rows = 0
      for (const row of reservations.values()) {
        if (
          row.operation === key.operation &&
          row.subjectId === key.subjectId &&
          row.day === day
        )
          rows += 1
      }
      const counter = daysOf(counters, key)?.get(day)
      return { reservations: rows, counter: counter === undefined ? null : { ...counter } }
    },
  }
}
