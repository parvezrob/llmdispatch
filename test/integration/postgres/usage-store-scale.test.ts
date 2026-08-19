import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DAY,
  DEADLINE_MS,
  KEY,
  LEASE_MS,
  SLOW_MS,
  admitted,
  at,
  measure,
  usageHelpers,
} from './helpers'
import { createPool, describeDatabase, dropSchema, migrate, uniqueSchema } from './setup'

const SCHEMA = uniqueSchema('scale')

let pool: pg.Pool

const {
  QUOTED,
  STATEMENTS,
  PRUNE,
  MAINTENANCE,
  fixture,
  onRealTime,
  reservationStates,
  explain,
  seedDays,
  daysHeld,
  churn,
  lapsed,
} = usageHelpers(() => pool, SCHEMA)

describeDatabase('the PostgreSQL usage store under load', () => {
  beforeAll(async () => {
    pool = createPool({ max: 20 })
    await migrate(pool, SCHEMA)
  })

  afterAll(async () => {
    await dropSchema(pool, SCHEMA)
    await pool.end()
  })

  describe('the pruning example the migration ships', () => {
    it('removes only what is two days past its day, and terminates', async () => {
      await onRealTime()
      await seedDays()

      for (const statement of PRUNE) {
        for (let rounds = 0; ; rounds += 1) {
          // A batched delete that never reports zero would loop for ever in production too.
          expect(rounds).toBeLessThan(10)
          if ((await pool.query(statement)).rowCount === 0) break
        }
      }

      expect(await daysHeld('usage_settlements')).toEqual([-1, 0])
      // The old row still under an unexpired lease stays: pruning never takes a live slot.
      expect(await daysHeld('usage_reservations')).toEqual([-3, -1, 0])
      expect(await daysHeld('usage_counters')).toEqual([-1, 0])
    })

    it('reaches the rows it deletes through the day index', async () => {
      await onRealTime()
      // A busy table where only a fraction of the rows are old enough to prune, which is the
      // shape a real one has when the example runs.
      await pool.query(
        `INSERT INTO ${QUOTED}.usage_settlements
           (reservation_id, operation, subject_id, day, outcome, attempts, settled_at)
         SELECT gen_random_uuid()::text, 'summarize', 'user-1',
                (now() AT TIME ZONE 'UTC')::date - CASE WHEN n % 200 = 0 THEN 5 ELSE 0 END,
                'succeeded', '[]'::jsonb, now()
           FROM generate_series(1, 50000) AS n`,
      )
      await pool.query(`ANALYZE ${QUOTED}.usage_settlements`)

      const plan = await explain(PRUNE[0] ?? '')

      expect(plan).toContain('usage_settlements_day')
      expect(plan).not.toContain('Seq Scan')
    })

    it('lets two pruners run at the same time without deadlocking', async () => {
      await onRealTime()
      await seedDays()

      const runs = [0, 1].map(() =>
        Promise.all(PRUNE.map((statement) => pool.query(statement))),
      )

      await expect(Promise.all(runs)).resolves.toBeDefined()
    })

    it('keeps the counter exact when the maintenance statement expires a batch', async () => {
      const { stores, controls } = await fixture(5_000)
      for (let slot = 0; slot < 3; slot += 1) admitted(await stores.usage.reserve(KEY, 3))
      await controls.setTime(at(6_000))

      await pool.query(MAINTENANCE, [KEY.operation, KEY.subjectId, DAY])

      expect(await controls.inspect(KEY, DAY)).toEqual({
        reservations: 3,
        counter: { used: 0, lastAdmitted: false },
      })
      expect(await reservationStates()).toEqual(['expired', 'expired', 'expired'])
    })
  })

  describe('at the scale the contract permits', () => {
    const BUSY = { operation: 'summarize', subjectId: 'busy' }
    const MILLION = 1_000_000

    it(
      'answers inside its deadline with a million committed rows, vacuumed or not',
      async () => {
        const { stores } = await onRealTime()
        await churn(BUSY, MILLION)

        const cold = await measure(() => stores.usage.reserve(BUSY, MILLION + 1))
        const coldSnapshot = await measure(() => stores.usage.snapshot(BUSY))
        await pool.query(`VACUUM (ANALYZE) ${QUOTED}.usage_reservations`)
        const warm = await measure(() => stores.usage.reserve(BUSY, MILLION + 2))
        const warmSnapshot = await measure(() => stores.usage.snapshot(BUSY))

        expect(cold.ms).toBeLessThan(DEADLINE_MS)
        expect(coldSnapshot.ms).toBeLessThan(DEADLINE_MS)
        expect(warm.ms).toBeLessThan(DEADLINE_MS)
        expect(warmSnapshot.ms).toBeLessThan(DEADLINE_MS)
        expect(coldSnapshot.value.used).toBe(MILLION + 1)
        expect(warmSnapshot.value.used).toBe(MILLION + 2)

        const plan = await explain(STATEMENTS.reserve, [
          BUSY.operation,
          BUSY.subjectId,
          MILLION,
          LEASE_MS,
          null,
        ])
        expect(plan).toContain('usage_reservations_pending')
        expect(plan).not.toContain('Sort')
        expect(plan).not.toContain(`Seq Scan on usage_reservations`)
      },
      SLOW_MS,
    )

    it(
      'reclaims a hundred thousand lapsed rows in one reserve',
      async () => {
        const { stores } = await onRealTime()
        await lapsed(BUSY, 100_000)

        const reserve = await measure(() => stores.usage.reserve(BUSY, 1))

        // Timed rather than held to a bound: what this proves is that one statement reclaims
        // the lot and still admits, which is the claim. How long that takes is the runner's.
        process.stdout.write(
          `a reserve reclaiming 100000 lapsed rows took ${String(reserve.ms)} ms\n`,
        )
        expect(reserve.value.ok).toBe(true)
        expect((await stores.usage.snapshot(BUSY)).used).toBe(1)
      },
      SLOW_MS,
    )

    it(
      'reclaims a million lapsed rows in one reserve, however long that takes',
      async () => {
        const { stores } = await onRealTime()
        await lapsed(BUSY, MILLION)

        const reserve = await measure(() => stores.usage.reserve(BUSY, 1))

        // A million reservations stranded between reserve and dispatch for one subject in one
        // day is a recovery, not a working day, so this one is timed and not bounded either.
        process.stdout.write(
          `a reserve reclaiming ${String(MILLION)} lapsed rows took ${String(reserve.ms)} ms\n`,
        )
        expect(reserve.value.ok).toBe(true)
        expect((await stores.usage.snapshot(BUSY)).used).toBe(1)
      },
      SLOW_MS,
    )
  })
})
