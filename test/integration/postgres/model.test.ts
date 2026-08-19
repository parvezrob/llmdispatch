import fc from 'fast-check'
import type pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { createMemoryStores } from '../../../src/stores/memory'
import { createPostgresStores } from '../../../src/stores/postgres'
import { LEASE_MS, observe, referenceSystem, storeScript } from '../../helpers/store-model'
import type { QuotaSystem } from '../../helpers/store-model'
import { createPool, describeDatabase, dropSchema, migrate, uniqueSchema } from './setup'

const SCHEMA = uniqueSchema('model')

describeDatabase('the two stores against the reference model', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = createPool()
    await migrate(pool, SCHEMA)
  })

  afterAll(async () => {
    await dropSchema(pool, SCHEMA)
    await pool.end()
  })

  it('answer exactly what the model answers, command for command', async () => {
    await fc.assert(
      fc.asyncProperty(storeScript, async (script) => {
        // One script, three systems: the reference counts rows, the in-memory store keeps a
        // counter in maps, and PostgreSQL keeps one in a table. Comparing all three on the
        // same trace is what stops the two implementations drifting from each other.
        const postgres = createPostgresStores({ pool, schema: SCHEMA, leaseMs: LEASE_MS })
        await postgres.controls.reset()
        const postgresSystem: QuotaSystem = {
          store: postgres.stores.usage,
          setTime: postgres.controls.setTime,
          readSettled: postgres.controls.readSettled,
        }
        const memory = createMemoryStores({ leaseMs: LEASE_MS })
        const memorySystem: QuotaSystem = {
          store: memory.stores.usage,
          setTime: memory.controls.setTime,
          readSettled: memory.controls.readSettled,
        }

        const expected = await observe(referenceSystem(), script)

        expect(await observe(memorySystem, script)).toEqual(expected)
        expect(await observe(postgresSystem, script)).toEqual(expected)
      }),
      { numRuns: 100 },
    )
  }, 120_000)
})
