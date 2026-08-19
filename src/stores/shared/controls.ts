/**
 * The seams the conformance runners and the package's own tests drive a store pair through.
 *
 * Declared once so the in-memory and PostgreSQL factories hand back the same shape and a suite
 * written against one runs against the other unchanged. Every control is asynchronous: the
 * PostgreSQL pair reaches a database to answer any of them.
 *
 * @module
 */

import type { AttemptRecord, QuotaKey, ReservationEnvelope, StorePair } from '../../types'

/** What `settle` persisted, as `readSettled` reports it. */
export interface SettlementRecord {
  reservation: ReservationEnvelope
  outcome: 'succeeded' | 'failed'
  attempts: AttemptRecord[]
}

/** What a store reports about one key and day, counter row included. */
export interface UsageInspection {
  reservations: number
  counter: { used: number; lastAdmitted: boolean } | null
}

/** The controls an internal store factory supplies (spec §6b, plus the white-box `inspect`). */
export interface StoreControls {
  setTime: (date: Date) => Promise<void>
  reset: () => Promise<void>
  readSettled: (reservationId: string) => Promise<SettlementRecord | null>
  seedRaw: (operation: string, value: unknown) => Promise<void>
  inspect: (key: QuotaKey, day: string) => Promise<UsageInspection>
}

/** A store pair with its controls, as an internal factory builds it. */
export interface InternalStores {
  stores: StorePair
  controls: StoreControls
}
