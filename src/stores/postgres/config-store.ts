/**
 * The PostgreSQL route store: rows of `jsonb`, returned exactly as they were written.
 *
 * Whether a stored row means anything is the core's question (spec §2); this store's whole
 * job is fidelity. Values travel as JSON in both directions, so what a caller hands over and
 * what a reader gets back are always separate objects.
 *
 * @module
 */

import type { ConfigStore } from '../../types'
import type { QueryablePool } from './driver'
import { assertStoreString, validatedRoute } from '../shared/domain'
import { objectRows, readColumn, readString, resultRows } from './driver'
import { configStatements } from './sql'

/** The store plus the seam the internal factory's `seedRaw` control is built on. */
export interface PostgresConfigStore {
  store: ConfigStore
  seedRaw: (operation: string, value: unknown) => Promise<void>
}

/**
 * Builds a PostgreSQL route store.
 *
 * @param options `pool` runs the statements and `schema` is the quoted identifier.
 */
export function createPostgresConfigStore(options: {
  pool: QueryablePool
  schema: string
}): PostgresConfigStore {
  const { pool } = options
  const statements = configStatements(options.schema)

  async function write(operation: string, route: unknown): Promise<void> {
    await pool.query(statements.set, [operation, JSON.stringify(route)])
  }

  return {
    store: {
      async getAll() {
        const result = await pool.query(statements.getAll)
        // `Object.fromEntries` defines own properties, so an operation named `__proto__` or
        // `constructor` comes back as an ordinary key rather than reaching the prototype. The
        // routes are cloned because a driver is free to hand the same object to two callers,
        // and one of them editing it must not change what the other reads.
        return Object.fromEntries(
          objectRows(resultRows(result)).map((row) => [
            readString(row, 'operation'),
            structuredClone(readColumn(row, 'route')),
          ]),
        )
      },
      async set(operation, route) {
        assertStoreString(operation, 'operation')
        // The checked copy is what is written, never the caller's object read a second time.
        await write(operation, validatedRoute(route))
      },
      async delete(operation) {
        assertStoreString(operation, 'operation')
        await pool.query(statements.delete, [operation])
      },
    },
    seedRaw: write,
  }
}
