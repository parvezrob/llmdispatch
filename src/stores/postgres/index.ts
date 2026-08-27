/**
 * The PostgreSQL store pair: routes and quota counters in a schema you own.
 *
 * Bring your own pool: the package has no driver dependency and never opens a connection of
 * its own. Nothing here runs DDL either: apply `migrationSql()` from `llmdispatch/postgres`
 * first, and this pair will find its tables where the migration put them.
 *
 * @module
 */

import type { StorePair } from '../../types'
import type { InternalStores } from '../shared/controls'
import type { QueryablePool } from './driver'
import { createStoreClock } from '../shared/clock'
import { DEFAULT_LEASE_MS, assertLeaseMs } from '../shared/lease'
import { createPostgresConfigStore } from './config-store'
import { DEFAULT_SCHEMA, quotedSchema } from './identifiers'
import { createPostgresUsageStore } from './usage-store'

/** What the internal factory accepts; `postgresStores()` takes everything but the clock (§6). */
export interface PostgresStoreOptions {
  pool: QueryablePool
  schema?: string
  leaseMs?: number
  now?: () => Date
}

/**
 * Builds a PostgreSQL store pair with its test controls.
 *
 * @param options `pool` runs every statement; `schema`, `leaseMs` and `now` default to
 * `llmdispatch`, 120 000 ms and the database's own clock.
 * @throws `RangeError` when `schema` is not a name llmdispatch may own, or `leaseMs` is outside
 * 5 000–600 000.
 */
export function createPostgresStores(options: PostgresStoreOptions): InternalStores {
  const schema = quotedSchema(options.schema ?? DEFAULT_SCHEMA)
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  assertLeaseMs(leaseMs)
  const clock = createStoreClock(options.now)
  const { pool } = options
  // Nothing pinned and no clock supplied leaves the instant to the database, which is the one
  // referee every process in a deployment already shares.
  const usage = createPostgresUsageStore({ pool, schema, leaseMs, now: clock.at })
  const config = createPostgresConfigStore({ pool, schema })

  return {
    stores: { config: config.store, usage: usage.store },
    controls: {
      setTime: (date) =>
        Promise.resolve().then(() => {
          clock.setTime(date)
        }),
      reset: async () => {
        await usage.reset()
        clock.unpin()
      },
      readSettled: (reservationId) => usage.readSettled(reservationId),
      seedRaw: (operation, value) => config.seedRaw(operation, value),
      inspect: (key, day) => usage.inspect(key, day),
    },
  }
}

/**
 * Builds the PostgreSQL config and usage stores (spec §6): no query runs at construction, the
 * schema is validated and the database is not touched.
 *
 * @param opts `pool` is your own driver pool, which must run at `READ COMMITTED`
 * (PostgreSQL's default; a stricter level makes concurrent reserves abort rather than deny);
 * `schema` defaults to `llmdispatch` and `leaseMs` to 120 000.
 * @throws `RangeError` when `schema` is not a name llmdispatch may own, or `leaseMs` is outside
 * 5 000–600 000.
 */
export function postgresStores(opts: {
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }
  schema?: string
  leaseMs?: number
}): StorePair {
  // Only the three documented options travel: the clock the internal factory takes is not
  // part of this signature.
  const options: PostgresStoreOptions = { pool: opts.pool }
  if (opts.schema !== undefined) options.schema = opts.schema
  if (opts.leaseMs !== undefined) options.leaseMs = opts.leaseMs
  return createPostgresStores(options).stores
}
