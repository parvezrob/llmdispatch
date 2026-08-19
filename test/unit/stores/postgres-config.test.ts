import { describe, expect, it } from 'vitest'

import { postgresStores } from '../../../src/stores/postgres'
import type { QueryablePool } from '../../../src/stores/postgres/driver'

/** Operation names that mean something to a JavaScript object and nothing to a database. */
const SPECIAL = ['', '__proto__', 'constructor', 'toString']

/** A pool that answers the rows a database would hold for these operations. */
function poolWith(rows: { operation: string; route: unknown }[]): QueryablePool {
  return { query: () => Promise.resolve({ rows }) }
}

describe('the PostgreSQL route store', () => {
  it('returns an operation named like an object member as an ordinary key', async () => {
    const rows = SPECIAL.map((operation) => ({
      operation,
      route: { provider: 'claude', model: operation },
    }))
    const stores = postgresStores({ pool: poolWith(rows) })

    const all = await stores.config.getAll()

    expect(Object.keys(all).sort()).toEqual([...SPECIAL].sort())
    for (const operation of SPECIAL) {
      expect(Object.hasOwn(all, operation)).toBe(true)
      expect(all[operation]).toEqual({ provider: 'claude', model: operation })
    }
    // Own properties throughout: nothing reached a prototype on the way in or out.
    expect(Object.getPrototypeOf(all)).toBe(Object.prototype)
    expect(typeof {}.toString).toBe('function')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('returns a row exactly as the database holds it, whatever shape it is in', async () => {
    const rows = [
      { operation: 'a-string', route: 'not a route at all' },
      { operation: 'a-number', route: 7 },
      { operation: 'nothing', route: null },
      { operation: 'wrong-field', route: { provider: 'claude', model: 4 } },
    ]
    const stores = postgresStores({ pool: poolWith(rows) })

    expect(await stores.config.getAll()).toEqual({
      'a-string': 'not a route at all',
      'a-number': 7,
      nothing: null,
      'wrong-field': { provider: 'claude', model: 4 },
    })
  })

  it('refuses a result that is not made of rows', async () => {
    const stores = postgresStores({
      pool: { query: () => Promise.resolve({ rows: ['nonsense'] }) },
    })

    await expect(stores.config.getAll()).rejects.toThrow(TypeError)
  })
})
