/**
 * What the two PostgreSQL usage suites are built from: the fixed clock they work against, the
 * helpers that read the tables behind the store's back, and the fixtures the scale legs need.
 *
 * The pool arrives as a function because each suite opens its own in `beforeAll`, after this
 * module has been evaluated.
 */

import type pg from 'pg'

import { createPostgresStores } from '../../../src/stores/postgres'
import { migrationSql } from '../../../src/stores/postgres/migrations'
import { usageStatements } from '../../../src/stores/postgres/sql'
import type { AttemptRecord, ReservationEnvelope, UsageStore } from '../../../src/types'

export const START = '2026-01-15T12:00:00.000Z'
export const DAY = '2026-01-15'
export const RESETS_AT = '2026-01-16T00:00:00.000Z'
export const LEASE_MS = 60_000

export const KEY = { operation: 'summarize', subjectId: 'user-1' }

/** A string no relational store can hold verbatim: PostgreSQL text rejects U+0000. */
export const UNSTORABLE = 'a\u0000b'

/** How long a test waits before deciding a statement is blocked on a lock. */
export const WAIT_MS = 200

/** The deadline the core holds a store call to (spec §6a). */
export const DEADLINE_MS = 10_000

/** Room for the tests that build a million rows before they measure anything. */
export const SLOW_MS = 300_000

export const RECORD: AttemptRecord = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  outcome: 'succeeded',
  status: 200,
  usage: { inputTokens: 120, outputTokens: 34 },
  costUsd: 0.00042,
  durationMs: 250,
}

export type ReserveResult = Awaited<ReturnType<UsageStore['reserve']>>

/** One row of the reserve statement, read without the store's own reader. */
export interface ReserveRow {
  reservation_id: string | null
  expires_at: string | null
  day: string
  resets_at: string
  used: number
}

export function admitted(result: ReserveResult): ReservationEnvelope {
  if (!result.ok) throw new Error(`the reserve was denied with used ${String(result.used)}`)
  return result.reservation
}

export function denied(result: ReserveResult): { used: number; resetsAt: string } {
  if (result.ok) throw new Error('the reserve was admitted')
  return result
}

export function leaseOf(result: ReserveResult): string {
  if (!result.ok) throw new Error('the reserve was denied')
  return result.expiresAt
}

/** Where the clock stands, `ms` after the fixed start of the day. */
export function at(ms: number): Date {
  return new Date(Date.parse(START) + ms)
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A promise and whether it has settled: how a test says "that one waited for a lock". */
export function watch<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  return {
    promise: promise.finally(() => {
      done = true
    }),
    settled: () => done,
  }
}

/** What a call answered, and how long it took to answer it. */
export async function measure<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await run()
  return { value, ms: Date.now() - started }
}

/**
 * The helpers that need a database: everything that reads or seeds one suite's own schema.
 *
 * @param poolOf The suite's pool, once it has one.
 * @param schema The schema the suite migrated.
 */
export function usageHelpers(poolOf: () => pg.Pool, schema: string) {
  const QUOTED = `"${schema}"`
  const STATEMENTS = usageStatements(QUOTED)

  /** A store pair on this file's schema, wiped and with its clock pinned to a fixed instant. */
  async function fixture(leaseMs = LEASE_MS) {
    const pair = createPostgresStores({ pool: poolOf(), schema, leaseMs })
    await pair.controls.reset()
    await pair.controls.setTime(new Date(START))
    return pair
  }

  /** Every reservation of one key and day, as the tables hold them. */
  async function reservationStates(): Promise<string[]> {
    const { rows } = await poolOf().query<{ state: string }>(
      `SELECT state FROM ${QUOTED}.usage_reservations WHERE operation = $1 AND subject_id = $2
        ORDER BY created_at, reservation_id`,
      [KEY.operation, KEY.subjectId],
    )
    return rows.map((row) => row.state)
  }

  /** A connection with a transaction open on it, so whatever it touches stays locked. */
  async function heldTransaction() {
    const client = await poolOf().connect()
    await client.query('BEGIN')
    return {
      query: <R extends pg.QueryResultRow>(sql: string, params?: unknown[]) =>
        client.query<R>(sql, params),
      async commit() {
        await client.query('COMMIT')
        client.release()
      },
    }
  }

  /** The plan PostgreSQL would use for a statement, as one string. */
  async function explain(sql: string, params?: unknown[]): Promise<string> {
    const { rows } = await poolOf().query<Record<string, string>>(`EXPLAIN ${sql}`, params)
    return rows.map((row) => Object.values(row).join('')).join('\n')
  }

  /** One of the examples the migration ships as comments, with the comment markers taken off. */
  function shippedExample(from: string, to: string): string {
    const { sql } = migrationSql({ schema })
    return sql
      .slice(sql.indexOf(from), sql.indexOf(to))
      .split('\n')
      .filter((line) => line.startsWith('--   '))
      .map((line) => line.slice(5))
      .join('\n')
  }

  const PRUNE = shippedExample('-- Pruning.', '-- Maintenance,')
    .split(/^(?=DELETE)/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
  const MAINTENANCE = shippedExample('-- Maintenance,', '-- Version record')

  /** Rows on three different days, one of them still under a live lease. */
  async function seedDays(): Promise<void> {
    for (const daysAgo of [3, 1, 0]) {
      await poolOf().query(
        `INSERT INTO ${QUOTED}.usage_settlements
           (reservation_id, operation, subject_id, day, outcome, attempts, settled_at)
         VALUES (gen_random_uuid()::text, $1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int,
                 'succeeded', '[]'::jsonb, now())`,
        [KEY.operation, KEY.subjectId, daysAgo],
      )
      await poolOf().query(
        `INSERT INTO ${QUOTED}.usage_counters (operation, subject_id, day, used, last_admitted)
         VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, 1, true)`,
        [KEY.operation, KEY.subjectId, daysAgo],
      )
      await poolOf().query(
        `INSERT INTO ${QUOTED}.usage_reservations
           (reservation_id, operation, subject_id, day, state, created_at, expires_at, committed_at)
         VALUES (gen_random_uuid()::text, $1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int,
                 'committed', now(), now(), now())`,
        [KEY.operation, KEY.subjectId, daysAgo],
      )
    }
    // Three days old and still leased: nothing may prune this one.
    await poolOf().query(
      `INSERT INTO ${QUOTED}.usage_reservations
         (reservation_id, operation, subject_id, day, state, created_at, expires_at)
       VALUES (gen_random_uuid()::text, $1, $2, (now() AT TIME ZONE 'UTC')::date - 3,
               'pending', now(), now() + interval '1 hour')`,
      [KEY.operation, KEY.subjectId],
    )
  }

  /** Which days a table still holds rows for, counted back from today. */
  async function daysHeld(table: string): Promise<number[]> {
    const { rows } = await poolOf().query<{ offset: number }>(
      `SELECT DISTINCT (day - (now() AT TIME ZONE 'UTC')::date) AS offset
         FROM ${QUOTED}.${table} ORDER BY 1`,
    )
    return rows.map((row) => row.offset)
  }

  /** A day's worth of reservations that were held and then committed, as the churn leaves them. */
  async function churn(
    key: { operation: string; subjectId: string },
    rows: number,
  ): Promise<void> {
    await poolOf().query(
      `INSERT INTO ${QUOTED}.usage_reservations
         (reservation_id, operation, subject_id, day, state, created_at, expires_at)
       SELECT gen_random_uuid()::text, $1, $2, (now() AT TIME ZONE 'UTC')::date, 'pending',
              now(), now() + interval '1 hour'
         FROM generate_series(1, $3::int)`,
      [key.operation, key.subjectId, rows],
    )
    await poolOf().query(
      `UPDATE ${QUOTED}.usage_reservations SET state = 'committed', committed_at = now()
        WHERE operation = $1 AND subject_id = $2 AND state = 'pending'`,
      [key.operation, key.subjectId],
    )
    await poolOf().query(
      `INSERT INTO ${QUOTED}.usage_counters (operation, subject_id, day, used, last_admitted)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, $3::int, true)`,
      [key.operation, key.subjectId, rows],
    )
  }

  /** A day's worth of reservations whose leases all ran out while nothing was looking. */
  async function lapsed(
    key: { operation: string; subjectId: string },
    rows: number,
  ): Promise<void> {
    await poolOf().query(
      `INSERT INTO ${QUOTED}.usage_reservations
         (reservation_id, operation, subject_id, day, state, created_at, expires_at)
       SELECT gen_random_uuid()::text, $1, $2, (now() AT TIME ZONE 'UTC')::date, 'pending',
              now() - interval '2 hours', now() - interval '1 hour'
         FROM generate_series(1, $3::int)`,
      [key.operation, key.subjectId, rows],
    )
    await poolOf().query(
      `INSERT INTO ${QUOTED}.usage_counters (operation, subject_id, day, used, last_admitted)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, $3::int, true)`,
      [key.operation, key.subjectId, rows],
    )
  }

  /** A store pair on the database's own clock, for the tests that work in real days. */
  async function onRealTime() {
    const pair = createPostgresStores({ pool: poolOf(), schema })
    await pair.controls.reset()
    return pair
  }

  return {
    QUOTED,
    STATEMENTS,
    PRUNE,
    MAINTENANCE,
    fixture,
    onRealTime,
    reservationStates,
    heldTransaction,
    explain,
    seedDays,
    daysHeld,
    churn,
    lapsed,
  }
}
