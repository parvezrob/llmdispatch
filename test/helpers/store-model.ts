/**
 * The model behind the property test: a reference implementation of the quota protocol, the
 * commands a random script is made of, and one way of observing any store that runs them.
 *
 * The reference counts reservation rows directly, where a real store keeps a counter and
 * reclaims lapsed rows into it. Running the same script against both and comparing what they
 * report is what stops the two ways of arriving at the same number drifting apart.
 *
 * `limit` is generated as a non-negative safe integer, the domain the core validates before
 * a store ever sees it; NaN, fractional and infinite limits are not modelled.
 *
 * No test lives here: `test/unit/stores/model.test.ts` runs the memory store against it, and
 * the PostgreSQL suite runs its own store against the same script.
 */

import fc from 'fast-check'

import type { AttemptRecord, QuotaKey, ReservationEnvelope, UsageStore } from '../../src/types'

/** One step of a generated script. Reservations are referred to by the slot they were issued into. */
export type StoreCommand =
  | { kind: 'reserve'; key: number; limit: number }
  | { kind: 'commit'; slot: number }
  | { kind: 'settle'; slot: number; outcome: 'succeeded' | 'failed' }
  | { kind: 'snapshot'; key: number }
  | { kind: 'advance'; ms: number }

/** A few keys that share an operation and a subject, so nothing is separated by accident. */
export const KEYS: readonly QuotaKey[] = [
  { operation: 'summarize', subjectId: 'user-1' },
  { operation: 'summarize', subjectId: 'user-2' },
  { operation: 'translate', subjectId: 'user-1' },
]

/** Late in the day, so an advance of a minute or two often crosses midnight. */
export const START = '2026-03-08T23:58:00.000Z'

/** The shortest lease the contract allows, so leases lapse inside a short script. */
export const LEASE_MS = 5_000

const DAY_MS = 86_400_000

const RECORD: AttemptRecord = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  outcome: 'succeeded',
  status: 200,
  usage: { inputTokens: 12, outputTokens: 34 },
  costUsd: 0.0001,
  durationMs: 120,
}

/** Stands in for a reservation the script asks about before one was issued. */
const UNISSUED: ReservationEnvelope = {
  reservationId: '00000000-0000-4000-8000-000000000000',
  key: { operation: 'summarize', subjectId: 'user-1' },
  day: '2026-03-08',
}

/** Whatever a script is run against: a store, its clock, and what settle persisted. */
export interface QuotaSystem {
  store: UsageStore
  setTime(date: Date): Promise<void>
  readSettled(
    reservationId: string,
  ): Promise<{ outcome: string; attempts: AttemptRecord[] } | null>
}

function key(index: number): QuotaKey {
  return KEYS[index % KEYS.length] ?? UNISSUED.key
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function resetOf(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString()
}

/** The scripts the property runs: a few dozen commands over a handful of keys. */
export const storeScript: fc.Arbitrary<StoreCommand[]> = fc.array(
  fc.oneof(
    fc
      .tuple(fc.nat(KEYS.length - 1), fc.integer({ min: 0, max: 3 }))
      .map(([index, limit]): StoreCommand => ({ kind: 'reserve', key: index, limit })),
    fc.nat(5).map((slot): StoreCommand => ({ kind: 'commit', slot })),
    fc
      .tuple(fc.nat(5), fc.constantFrom<'succeeded' | 'failed'>('succeeded', 'failed'))
      .map(([slot, outcome]): StoreCommand => ({ kind: 'settle', slot, outcome })),
    fc.nat(KEYS.length - 1).map((index): StoreCommand => ({ kind: 'snapshot', key: index })),
    fc.integer({ min: 1, max: 150_000 }).map((ms): StoreCommand => ({ kind: 'advance', ms })),
  ),
  { minLength: 1, maxLength: 40 },
)

/**
 * Runs a script and reports what the system said, one line per command.
 *
 * Reservation ids never appear: a command names the slot a reserve issued into, and so does
 * the report, which is the correspondence that lets two systems be compared at all.
 */
export async function observe(
  system: QuotaSystem,
  script: readonly StoreCommand[],
): Promise<string[]> {
  const issued: ReservationEnvelope[] = []
  const report: string[] = []
  let at = Date.parse(START)
  await system.setTime(new Date(at))

  for (const command of script) {
    switch (command.kind) {
      case 'reserve': {
        const result = await system.store.reserve(key(command.key), command.limit)
        report.push(
          result.ok
            ? `reserve(${String(command.key)}, ${String(command.limit)}) -> slot ${String(issued.length)} on ${result.reservation.day} until ${result.expiresAt}`
            : `reserve(${String(command.key)}, ${String(command.limit)}) -> denied, used ${String(result.used)}, resets ${result.resetsAt}`,
        )
        if (result.ok) issued.push(result.reservation)
        break
      }
      case 'commit': {
        const envelope = issued[command.slot] ?? UNISSUED
        const answer = await system.store.commit(envelope.reservationId)
        report.push(`commit(${String(command.slot)}) -> ${answer}`)
        break
      }
      case 'settle': {
        const envelope = issued[command.slot] ?? UNISSUED
        await system.store.settle(envelope, command.outcome, [RECORD])
        const settled = await system.readSettled(envelope.reservationId)
        report.push(
          `settle(${String(command.slot)}, ${command.outcome}) -> ${settled?.outcome ?? 'nothing'} with ${String(settled?.attempts.length ?? 0)} attempts`,
        )
        break
      }
      case 'snapshot': {
        const snapshot = await system.store.snapshot(key(command.key))
        report.push(
          `snapshot(${String(command.key)}) -> used ${String(snapshot.used)}, resets ${snapshot.resetsAt}`,
        )
        break
      }
      case 'advance': {
        at += command.ms
        await system.setTime(new Date(at))
        report.push(`advance(${String(command.ms)}) -> ${new Date(at).toISOString()}`)
        break
      }
    }
  }
  return report
}

/** One reservation, as the reference keeps it. */
interface ModelRow {
  id: string
  operation: string
  subjectId: string
  day: string
  state: 'pending' | 'committed' | 'expired'
  expiresAt: number
  fenced: boolean
}

/**
 * The reference implementation of spec §4, written the obvious way.
 *
 * It counts rows instead of keeping a counter, and reclaims by walking them, so agreeing with
 * a real store means the two arrived at the same answer from different directions.
 */
export function referenceSystem(leaseMs = LEASE_MS): QuotaSystem {
  const rows: ModelRow[] = []
  const settled = new Map<string, { outcome: string; attempts: AttemptRecord[] }>()
  let issued = 0
  let at = Date.parse(START)

  const of = (target: QuotaKey, day: string) =>
    rows.filter(
      (row) =>
        row.operation === target.operation &&
        row.subjectId === target.subjectId &&
        row.day === day,
    )

  return {
    setTime: (date) => {
      at = date.getTime()
      return Promise.resolve()
    },
    readSettled: (reservationId) => Promise.resolve(settled.get(reservationId) ?? null),
    store: {
      reserve: (target, limit) => {
        const day = dayOf(at)
        for (const row of of(target, day)) {
          if (row.state === 'pending' && row.expiresAt <= at) row.state = 'expired'
        }
        const used = of(target, day).filter((row) => row.state !== 'expired').length
        if (used >= limit) {
          return Promise.resolve({ ok: false as const, used, resetsAt: resetOf(day) })
        }
        issued += 1
        const id = `reservation-${String(issued)}`
        const expiresAt = Math.min(at + leaseMs, Date.parse(resetOf(day)))
        rows.push({
          id,
          operation: target.operation,
          subjectId: target.subjectId,
          day,
          state: 'pending',
          expiresAt,
          fenced: false,
        })
        return Promise.resolve({
          ok: true as const,
          reservation: {
            reservationId: id,
            key: { operation: target.operation, subjectId: target.subjectId },
            day,
          },
          expiresAt: new Date(expiresAt).toISOString(),
        })
      },
      commit: (reservationId) => {
        const row = rows.find((candidate) => candidate.id === reservationId)
        if (row === undefined) return Promise.resolve('missing' as const)
        if (row.state === 'committed') return Promise.resolve('committed' as const)
        if (row.state === 'expired') return Promise.resolve('expired' as const)
        if (!row.fenced && row.expiresAt > at) {
          row.state = 'committed'
          return Promise.resolve('committed' as const)
        }
        row.fenced = true
        return Promise.resolve('expired' as const)
      },
      settle: (reservation, outcome, attempts) => {
        if (!settled.has(reservation.reservationId)) {
          settled.set(reservation.reservationId, { outcome, attempts: [...attempts] })
        }
        return Promise.resolve()
      },
      snapshot: (target) => {
        const day = dayOf(at)
        const used = of(target, day).filter(
          (row) => row.state === 'committed' || (row.state === 'pending' && row.expiresAt > at),
        ).length
        return Promise.resolve({ used, resetsAt: resetOf(day) })
      },
    },
  }
}
