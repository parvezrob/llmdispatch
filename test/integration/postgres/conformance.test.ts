import type pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

import type { AttemptRecord } from '../../../src/types'
import { runConfigStoreConformance, runUsageStoreConformance } from '../../../src/conformance'
import { createPostgresStores, postgresStores } from '../../../src/stores/postgres'
import { USAGE_STORE_MARKER, controlStatements } from '../../../src/stores/postgres/sql'
import { createPool, describeDatabase, dropSchema, migrate, uniqueSchema } from './setup'

const SCHEMA = uniqueSchema('conformance')

/** A settlement row as the harness reads it back, without the store's own reader. */
interface SettlementRow {
  reservation_id: string
  operation: string
  subject_id: string
  day: string
  outcome: string
  attempts: AttemptRecord[]
}

describeDatabase('the store conformance suites on PostgreSQL', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = createPool()
    await migrate(pool, SCHEMA)
  })

  afterAll(async () => {
    await dropSchema(pool, SCHEMA)
    await pool.end()
  })

  it('passes the usage suite through the internal factory', async () => {
    const { stores, controls } = createPostgresStores({ pool, schema: SCHEMA })

    const result = await runUsageStoreConformance({
      create: () =>
        Promise.resolve({
          store: stores.usage,
          setTime: controls.setTime,
          reset: controls.reset,
          readSettled: controls.readSettled,
        }),
    })

    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('passes the config suite through the internal factory', async () => {
    const { stores, controls } = createPostgresStores({ pool, schema: SCHEMA })

    const result = await runConfigStoreConformance({
      create: () =>
        Promise.resolve({
          store: stores.config,
          reset: controls.reset,
          seedRaw: controls.seedRaw,
        }),
    })

    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('passes both suites through the public factory and a pool that supplies the clock', async () => {
    // The public factory has no clock option, so a harness drives its clock from the pool it
    // supplies: it knows the store's convention: a usage statement starts with the marker and
    // ends with the clock parameter, and substitutes that last parameter. The wrapper is
    // strict on purpose: if the convention ever drifted, this fails rather than quietly
    // testing the database's own clock.
    let pinned: Date | null = null
    const drifted: string[] = []
    const wrapper = {
      query(sql: string, params?: unknown[]) {
        if (!sql.startsWith(USAGE_STORE_MARKER)) return pool.query(sql, params)
        const supplied = [...(params ?? [])]
        if (supplied.length === 0) drifted.push('a usage statement carried no parameters')
        if (supplied.at(-1) !== null) drifted.push('a usage statement did not end with null')
        supplied[supplied.length - 1] = pinned?.toISOString() ?? null
        return pool.query(sql, supplied)
      },
    }
    const stores = postgresStores({ pool: wrapper, schema: SCHEMA })
    const controls = controlStatements(`"${SCHEMA}"`)

    const usage = await runUsageStoreConformance({
      create: () =>
        Promise.resolve({
          store: stores.usage,
          setTime: (date: Date) => {
            pinned = date
            return Promise.resolve()
          },
          reset: async () => {
            pinned = null
            await pool.query(controls.truncate)
          },
          readSettled: async (reservationId: string) => {
            const { rows } = await pool.query<SettlementRow>(controls.readSettled, [
              reservationId,
            ])
            const [row] = rows
            return row === undefined
              ? null
              : {
                  reservation: {
                    reservationId: row.reservation_id,
                    key: { operation: row.operation, subjectId: row.subject_id },
                    day: row.day,
                  },
                  outcome: row.outcome,
                  attempts: row.attempts,
                }
          },
        }),
    })
    const config = await runConfigStoreConformance({
      create: () =>
        Promise.resolve({
          store: stores.config,
          reset: () => pool.query(controls.truncate).then(() => undefined),
          seedRaw: (operation: string, value: unknown) =>
            pool
              .query(
                `INSERT INTO "${SCHEMA}".operation_routes (operation, route) VALUES ($1, $2::jsonb)
                      ON CONFLICT (operation) DO UPDATE SET route = EXCLUDED.route`,
                [operation, JSON.stringify(value)],
              )
              .then(() => undefined),
        }),
    })

    expect(drifted).toEqual([])
    expect(usage).toEqual({ passed: true, failures: [], skipped: [] })
    expect(config).toEqual({ passed: true, failures: [], skipped: [] })
  })
})
