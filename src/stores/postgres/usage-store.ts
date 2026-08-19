/**
 * The PostgreSQL usage store: the quota state machine of spec §4, one statement per method.
 *
 * A pool gives no way to hold a transaction open across calls, so each method sends exactly
 * one command and the database's row locks are the critical section. What that costs in SQL
 * it buys in correctness: two concurrent reserves cannot both admit the last slot.
 *
 * @module
 */

import type { AttemptRecord, QuotaKey, ReservationEnvelope, UsageStore } from '../../types'
import type { SettlementRecord, UsageInspection } from '../shared/controls'
import type { QueryablePool } from './driver'
import { projectAttempts } from '../shared/attempts'
import {
  assertStoreDay,
  assertStoreString,
  isStoreString,
  validatedKey,
} from '../shared/domain'
import {
  malformed,
  optionalRow,
  readBoolean,
  readDay,
  readInstant,
  readInteger,
  readOptionalInstant,
  readOptionalReservationId,
  readReservationId,
  readStoreString,
  readString,
  resultRows,
  singleRow,
} from './driver'
import { controlStatements, usageStatements } from './sql'

/** The store plus the seams the internal factory's controls are built on. */
export interface PostgresUsageStore {
  store: UsageStore
  reset: () => Promise<void>
  readSettled: (reservationId: string) => Promise<SettlementRecord | null>
  inspect: (key: QuotaKey, day: string) => Promise<UsageInspection>
}

/** What a commit answers, so an unexpected value is caught rather than passed on. */
const COMMIT_RESULTS = ['committed', 'expired', 'missing'] as const

type CommitResult = (typeof COMMIT_RESULTS)[number]

function isCommitResult(value: string): value is CommitResult {
  return COMMIT_RESULTS.some((result) => result === value)
}

/** The two outcomes a settlement row may carry (spec §6). */
const OUTCOMES = ['succeeded', 'failed'] as const

function isOutcome(value: string): value is (typeof OUTCOMES)[number] {
  return OUTCOMES.some((outcome) => outcome === value)
}

/**
 * Builds a PostgreSQL usage store.
 *
 * @param options `pool` runs the statements, `schema` is quoted, `leaseMs` is the lease, and
 * `now` overrides the store's clock — `null` leaves the instant to the database.
 */
export function createPostgresUsageStore(options: {
  pool: QueryablePool
  schema: string
  leaseMs: number
  now: () => Date | null
}): PostgresUsageStore {
  const { pool } = options
  const statements = usageStatements(options.schema)
  const controls = controlStatements(options.schema)

  /** The clock override every usage statement takes last: an instant, or the database's own. */
  function clockParameter(): string | null {
    return options.now()?.toISOString() ?? null
  }

  async function reserve(
    key: QuotaKey,
    limit: number,
  ): Promise<
    | { ok: true; reservation: ReservationEnvelope; expiresAt: string }
    | { ok: false; used: number; resetsAt: string }
  > {
    const checked = validatedKey(key)
    const result = await pool.query(statements.reserve, [
      checked.operation,
      checked.subjectId,
      limit,
      options.leaseMs,
      clockParameter(),
    ])
    // Every column the statement selects is read and checked before the answer is decided, so
    // a denial can never be reported off a row malformed in the part only a grant reads.
    const row = singleRow(resultRows(result))
    const used = readInteger(row, 'used')
    const resetsAt = readInstant(row, 'resets_at')
    const day = readDay(row, 'day')
    const reservationId = readOptionalReservationId(row, 'reservation_id')
    const expiresAt = readOptionalInstant(row, 'expires_at')

    if (reservationId === null || expiresAt === null) {
      // The statement writes both or neither; one of each is a row no version of it produces.
      if (reservationId !== null || expiresAt !== null) {
        malformed('a reservation with only half of its row')
      }
      return { ok: false, used, resetsAt }
    }
    // The key exactly as it was checked; the day is the store's (§4).
    return { ok: true, reservation: { reservationId, key: checked, day }, expiresAt }
  }

  async function commit(reservationId: string): Promise<CommitResult> {
    // An id no store could hold is one this store cannot have issued (§4: unknown -> missing),
    // and asking the database about it would be a query for an answer already known.
    if (!isStoreString(reservationId)) return 'missing'
    const result = await pool.query(statements.commit, [reservationId, clockParameter()])
    const answer = readString(singleRow(resultRows(result)), 'result')
    if (!isCommitResult(answer)) {
      throw new TypeError(`the store answered a commit with ${answer}`)
    }
    return answer
  }

  async function settle(
    reservation: ReservationEnvelope,
    outcome: 'succeeded' | 'failed',
    attempts: AttemptRecord[],
  ): Promise<void> {
    // Every part of the envelope is read once and it is that reading which is checked and
    // bound. Projected and serialised before the first await too, so a caller editing the
    // array on the next line cannot change what is written.
    const { reservationId, day } = reservation
    assertStoreString(reservationId, 'reservationId')
    assertStoreDay(day)
    const key = validatedKey(reservation.key)
    const records = JSON.stringify(projectAttempts(attempts))
    await pool.query(statements.settle, [
      reservationId,
      key.operation,
      key.subjectId,
      day,
      outcome,
      records,
      clockParameter(),
    ])
  }

  async function snapshot(key: QuotaKey): Promise<{ used: number; resetsAt: string }> {
    const checked = validatedKey(key)
    const result = await pool.query(statements.snapshot, [
      checked.operation,
      checked.subjectId,
      clockParameter(),
    ])
    const row = singleRow(resultRows(result))
    return { used: readInteger(row, 'used'), resetsAt: readInstant(row, 'resets_at') }
  }

  return {
    store: { reserve, commit, settle, snapshot },
    async reset() {
      await pool.query(controls.truncate)
    },
    async readSettled(reservationId) {
      const result = await pool.query(controls.readSettled, [reservationId])
      const row = optionalRow(resultRows(result))
      if (row === null) return null
      const attempts: unknown = row.attempts
      if (!Array.isArray(attempts)) {
        throw new TypeError('the store returned a settlement whose attempts are not an array')
      }
      const outcome = readString(row, 'outcome')
      // Reported, never repaired: a row the schema should not have allowed is worth seeing.
      if (!isOutcome(outcome)) {
        throw new TypeError(`the store returned a settlement whose outcome is ${outcome}`)
      }
      return {
        reservation: {
          reservationId: readReservationId(row, 'reservation_id'),
          key: {
            operation: readStoreString(row, 'operation'),
            subjectId: readStoreString(row, 'subject_id'),
          },
          day: readDay(row, 'day'),
        },
        outcome,
        // The row as it stands, not a rebuilt copy: a test asking what was persisted has to
        // be able to see anything that should not have been.
        attempts: attempts as AttemptRecord[],
      }
    },
    async inspect(key, day) {
      const result = await pool.query(controls.inspect, [key.operation, key.subjectId, day])
      const row = singleRow(resultRows(result))
      const used = row.used
      return {
        reservations: readInteger(row, 'reservations'),
        counter:
          used === null || used === undefined
            ? null
            : {
                used: readInteger(row, 'used'),
                lastAdmitted: readBoolean(row, 'last_admitted'),
              },
      }
    },
  }
}
