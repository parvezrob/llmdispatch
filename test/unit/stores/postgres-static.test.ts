import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPostgresStores, postgresStores } from '../../../src/stores/postgres'
import { DEFAULT_SCHEMA, quotedSchema } from '../../../src/stores/postgres/identifiers'
import { usageStatements } from '../../../src/stores/postgres/sql'
import { MIGRATIONS, migrationSql } from '../../../src/stores/postgres/migrations'
import type { QueryablePool } from '../../../src/stores/postgres/driver'

/**
 * The hash of migration 1 as it is published.
 *
 * Pinned so that editing the template is a decision: the template's own hash is what the
 * database records, and a change to it makes every applied version-1 schema a different one.
 */
const TEMPLATE_SHA256 = '404877cedf22ce3ed1ce6070f2d4710f9601e36cc4ac098385f1ac7216bd163f'

const KEY = { operation: 'summarize', subjectId: 'user-1' }

/** A pool that answers nothing and remembers everything it was asked. */
function recordingPool(): QueryablePool & { calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] })
      return Promise.resolve({ rows: [] })
    },
  }
}

/** Runs a call for the statement it sends; what a pool answering nothing makes of it is not
 * what these tests are about. */
function sent(call: Promise<unknown>): Promise<void> {
  return call.then(
    () => undefined,
    () => undefined,
  )
}

describe('the packaged migration', () => {
  it('renders with every token replaced and hashes exactly what it rendered', () => {
    const rendered = migrationSql({ schema: 'my_schema_2' })

    expect(rendered.sql).not.toContain('__SCHEMA__')
    expect(rendered.sql).not.toContain('__TEMPLATE_SHA256__')
    expect(rendered.sql).toContain('CREATE SCHEMA IF NOT EXISTS "my_schema_2"')
    expect(rendered.sql).toContain(`VALUES (1, '${TEMPLATE_SHA256}')`)
    expect(rendered.sha256).toBe(
      createHash('sha256').update(rendered.sql, 'utf8').digest('hex'),
    )
  })

  it('publishes one version, whose hash is the one this test pins', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1])
    expect(MIGRATIONS[0]?.templateSha256).toBe(TEMPLATE_SHA256)
  })

  it('concatenates every version in order and hashes the bytes that came out', () => {
    const aggregate = migrationSql()

    expect(aggregate.sql).toBe(MIGRATIONS.map((migration) => migration.render().sql).join('\n'))
    expect(aggregate.sha256).toBe(
      createHash('sha256').update(aggregate.sql, 'utf8').digest('hex'),
    )
    expect(migrationSql({ schema: 'llmdispatch' })).toEqual(aggregate)
  })

  it('renders for a different schema without changing the version it records', () => {
    const here = migrationSql({ schema: 'llmdispatch' })
    const there = migrationSql({ schema: 'other_schema' })

    expect(there.sql).not.toBe(here.sql)
    expect(there.sha256).not.toBe(here.sha256)
    expect(there.sql).toContain(TEMPLATE_SHA256)
  })
})

describe('the statements the usage store sends', () => {
  /**
   * Each statement as it is rendered for the default schema.
   *
   * Pinned for the same reason as the migration's own hash: the four are the protocol, proved
   * correct against a real database, so editing one has to be a decision and not a detail.
   */
  const STATEMENT_SHA256 = {
    reserve: '7485e2f259a7b7f723d16a89105f52a7b53f64802f8521abe66344c239c7e1e5',
    commit: '51fa87eefc789b7fe38ec3d1eeb8f4656706462e321b0decc9247053b80b075e',
    settle: '9567bc8b7c3f5de07961cbf5dce807c5e735e2a43a1f8fc1bd4b774e3305a481',
    snapshot: '77a2cbc2a56056a69175872255c385426643edcd9aa21440fe0649852a0533c4',
  }

  it('are the ones this test pins', () => {
    const statements = usageStatements(quotedSchema(DEFAULT_SCHEMA))

    for (const [name, sha256] of Object.entries(STATEMENT_SHA256)) {
      const text = statements[name as keyof typeof STATEMENT_SHA256]
      expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(sha256)
    }
  })
})

describe('the schema name', () => {
  const REFUSED = [
    'pg_catalog',
    'pg_temp_1',
    'information_schema',
    'MySchema',
    'my schema',
    'my-schema',
    '1schema',
    '',
    'a'.repeat(64),
    'schema";DROP TABLE x;--',
  ]

  it.each(REFUSED)('is refused by both factories when it is %j', (schema) => {
    expect(() => migrationSql({ schema })).toThrow(/schema/)
    expect(() => MIGRATIONS[0]?.render({ schema })).toThrow(/schema/)
    expect(() => postgresStores({ pool: recordingPool(), schema })).toThrow(/schema/)
  })

  it('accepts an unusual name that is still one PostgreSQL leaves alone', () => {
    expect(() => migrationSql({ schema: 'my_schema_2' })).not.toThrow()
    expect(() =>
      postgresStores({ pool: recordingPool(), schema: 'a'.repeat(63) }),
    ).not.toThrow()
  })
})

describe('the lease', () => {
  it.each([4_999, 600_001, 5_000.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'is refused when it is %j',
    (leaseMs) => {
      expect(() => postgresStores({ pool: recordingPool(), leaseMs })).toThrow(/leaseMs/)
    },
  )

  it('accepts both ends of the range the contract allows', () => {
    expect(() => postgresStores({ pool: recordingPool(), leaseMs: 5_000 })).not.toThrow()
    expect(() => postgresStores({ pool: recordingPool(), leaseMs: 600_000 })).not.toThrow()
  })
})

describe('the store pair', () => {
  it('asks the database nothing at all while it is being built', () => {
    const pool = recordingPool()

    postgresStores({ pool, schema: 'llmdispatch', leaseMs: 60_000 })

    expect(pool.calls).toEqual([])
  })

  it('sends every value as a bound parameter and none of them as text', async () => {
    const pool = recordingPool()
    const marker = 'a-value-that-must-never-be-spliced'
    const stores = postgresStores({ pool })

    await sent(stores.usage.reserve({ operation: marker, subjectId: marker }, 7))
    await sent(stores.usage.snapshot({ operation: marker, subjectId: marker }))
    await sent(
      stores.usage.settle(
        {
          reservationId: marker,
          key: { operation: marker, subjectId: marker },
          day: '2026-01-15',
        },
        'succeeded',
        [],
      ),
    )
    await sent(stores.config.set(marker, { provider: marker, model: marker }))
    await sent(stores.config.delete(marker))

    expect(pool.calls).toHaveLength(5)
    for (const call of pool.calls) {
      expect(call.sql).not.toContain(marker)
      expect(call.params).toContain(marker)
    }
  })

  it("marks the statements that end with the store's clock", async () => {
    const pool = recordingPool()
    const stores = postgresStores({ pool })

    await sent(stores.usage.reserve(KEY, 1))
    await sent(stores.usage.snapshot(KEY))
    await sent(
      stores.usage.settle({ reservationId: 'id', key: KEY, day: '2026-01-15' }, 'failed', []),
    )
    await sent(stores.config.getAll())

    const marked = pool.calls.filter((call) =>
      call.sql.startsWith('/* llmdispatch:usage-store */'),
    )
    expect(marked).toHaveLength(3)
    for (const call of marked) expect(call.params.at(-1)).toBeNull()
    expect(pool.calls.at(-1)?.sql.startsWith('/*')).toBe(false)
  })
})

describe('the public factory', () => {
  it('never lets a clock reach the statements, however it was called', async () => {
    const pool = recordingPool()
    // No cast is needed to try this: an object held in a variable may carry properties the
    // parameter does not declare, so the clock the internal factory takes is one `now` away
    // from the published signature unless the factory refuses to forward it.
    const opts = { pool, now: () => new Date('2020-01-01T00:00:00.000Z') }
    const stores = postgresStores(opts)

    await sent(stores.usage.reserve(KEY, 1))
    await sent(stores.usage.snapshot(KEY))

    expect(pool.calls).toHaveLength(2)
    for (const call of pool.calls) expect(call.params.at(-1)).toBeNull()
  })

  it('refuses a schema that is not a string at all', () => {
    // An object that answers `startsWith` and `toString` differently would otherwise pass the
    // pattern test and spell something else into the SQL.
    const twoFaced = {
      startsWith: () => false,
      toString: () => 'llmdispatch"; DROP SCHEMA public CASCADE; --',
    }

    expect(() =>
      postgresStores({ pool: recordingPool(), schema: twoFaced as unknown as string }),
    ).toThrow(/schema/)
    expect(() => migrationSql({ schema: twoFaced as unknown as string })).toThrow(/schema/)
  })
})

describe('what the store makes of a result', () => {
  /** A pool that answers one fixed result, whatever it is asked. */
  function answering(rows: unknown[]): QueryablePool {
    return { query: () => Promise.resolve({ rows }) }
  }

  const DENIAL = { reservation_id: null, expires_at: null, day: '2026-01-15', used: 0 }

  it('refuses a result with no row and one whose row is not an object', async () => {
    await expect(postgresStores({ pool: answering([]) }).usage.snapshot(KEY)).rejects.toThrow(
      /no row/,
    )
    await expect(
      postgresStores({ pool: answering(['nonsense']) }).usage.snapshot(KEY),
    ).rejects.toThrow(/not an object/)
  })

  it('refuses a row that is missing a column the statement selects', async () => {
    const stores = postgresStores({ pool: answering([{ ...DENIAL }]) })

    await expect(stores.usage.reserve(KEY, 0)).rejects.toThrow(/no "resets_at" column/)
  })

  it('refuses a count that is negative or not whole', async () => {
    const resetsAt = '2026-01-16T00:00:00.000Z'

    for (const used of [-1, 1.5]) {
      const stores = postgresStores({
        pool: answering([{ ...DENIAL, used, resets_at: resetsAt }]),
      })
      await expect(stores.usage.reserve(KEY, 0)).rejects.toThrow(/not a count/)
    }
  })

  it('refuses a result that carries no rows of its own', async () => {
    for (const result of [
      null,
      {},
      { rows: 'nonsense' },
      Object.create({ rows: [] }) as object,
    ]) {
      const stores = postgresStores({
        pool: { query: () => Promise.resolve(result as { rows: unknown[] }) },
      })
      await expect(stores.usage.snapshot(KEY)).rejects.toThrow(/rows/)
    }
  })

  it('refuses several rows where a statement returns one', async () => {
    const row = { ...DENIAL, resets_at: '2026-01-16T00:00:00.000Z' }
    const stores = postgresStores({ pool: answering([row, row]) })

    await expect(stores.usage.reserve(KEY, 0)).rejects.toThrow(/several rows/)
  })

  it('refuses a column the row carries as undefined', async () => {
    // A driver reports SQL NULL as null; undefined means the column is not really there.
    const stores = postgresStores({
      pool: answering([{ ...DENIAL, used: 0, resets_at: undefined }]),
    })

    await expect(stores.usage.reserve(KEY, 0)).rejects.toThrow(/undefined "resets_at"/)
  })

  it('refuses a reservation id it could not have issued', async () => {
    const admission = {
      expires_at: '2026-01-15T12:01:00.000Z',
      day: '2026-01-15',
      resets_at: '2026-01-16T00:00:00.000Z',
      used: 1,
    }

    for (const reservation_id of ['', 'an\u0000id', 'a'.repeat(1001)]) {
      const stores = postgresStores({ pool: answering([{ ...admission, reservation_id }]) })
      await expect(stores.usage.reserve(KEY, 1)).rejects.toThrow(/could have issued/)
    }
  })

  it('refuses a day that is not a UTC calendar day', async () => {
    const stores = postgresStores({
      pool: answering([
        {
          reservation_id: 'an-id',
          expires_at: '2026-01-15T12:01:00.000Z',
          day: 'not-a-day',
          resets_at: '2026-01-16T00:00:00.000Z',
          used: 1,
        },
      ]),
    })

    await expect(stores.usage.reserve(KEY, 1)).rejects.toThrow(/not a UTC calendar day/)
  })

  it('refuses a timestamp nothing could read', async () => {
    const admitted = {
      reservation_id: 'an-id',
      day: '2026-01-15',
      resets_at: '2026-01-16T00:00:00.000Z',
      used: 1,
    }
    const denied = { reservation_id: null, expires_at: null, day: '2026-01-15', used: 0 }

    await expect(
      postgresStores({
        pool: answering([{ ...admitted, expires_at: 'whenever' }]),
      }).usage.reserve(KEY, 1),
    ).rejects.toThrow(/not an instant/)
    await expect(
      postgresStores({
        pool: answering([{ ...denied, resets_at: 'whenever' }]),
      }).usage.reserve(KEY, 0),
    ).rejects.toThrow(/not an instant/)
    await expect(
      postgresStores({
        pool: answering([{ used: 0, resets_at: 'whenever' }]),
      }).usage.snapshot(KEY),
    ).rejects.toThrow(/not an instant/)
  })

  it('refuses a granted row whose count or reset it cannot read', async () => {
    const granted = {
      reservation_id: 'an-id',
      expires_at: '2026-01-15T12:01:00.000Z',
      day: '2026-01-15',
      resets_at: '2026-01-16T00:00:00.000Z',
      used: 1,
    }

    // Checked even though a grant reports neither: half a row is a schema problem either way.
    await expect(
      postgresStores({ pool: answering([{ ...granted, used: -1 }]) }).usage.reserve(KEY, 1),
    ).rejects.toThrow(/not a count/)
    await expect(
      postgresStores({
        pool: answering([{ ...granted, resets_at: 'whenever' }]),
      }).usage.reserve(KEY, 1),
    ).rejects.toThrow(/not an instant/)
  })

  it('refuses a denied row whose day or lease it cannot read', async () => {
    const refused = {
      reservation_id: null,
      expires_at: null,
      day: '2026-01-15',
      resets_at: '2026-01-16T00:00:00.000Z',
      used: 0,
    }

    await expect(
      postgresStores({ pool: answering([{ ...refused, day: 'not-a-day' }]) }).usage.reserve(
        KEY,
        0,
      ),
    ).rejects.toThrow(/not a UTC calendar day/)
    await expect(
      postgresStores({
        pool: answering([{ ...refused, expires_at: 'whenever' }]),
      }).usage.reserve(KEY, 0),
    ).rejects.toThrow(/not an instant/)
  })

  it('refuses a row that is half a reservation', async () => {
    const row = {
      day: '2026-01-15',
      resets_at: '2026-01-16T00:00:00.000Z',
      used: 1,
    }

    await expect(
      postgresStores({
        pool: answering([{ ...row, reservation_id: 'an-id', expires_at: null }]),
      }).usage.reserve(KEY, 1),
    ).rejects.toThrow(/half of its row/)
    await expect(
      postgresStores({
        pool: answering([
          { ...row, reservation_id: null, expires_at: '2026-01-15T12:01:00.000Z' },
        ]),
      }).usage.reserve(KEY, 1),
    ).rejects.toThrow(/half of its row/)
  })

  it('refuses a route the row does not really carry', async () => {
    const inherited = Object.create({ route: { provider: 'claude', model: 'x' } }) as object
    Object.assign(inherited, { operation: 'summarize' })

    for (const row of [
      { operation: 'summarize' },
      { operation: 'summarize', route: undefined },
    ]) {
      await expect(postgresStores({ pool: answering([row]) }).config.getAll()).rejects.toThrow(
        /"route"/,
      )
    }
    await expect(
      postgresStores({ pool: answering([inherited]) }).config.getAll(),
    ).rejects.toThrow(/no "route" column/)
  })

  it('refuses a settled reservation id no store could have issued', async () => {
    const settlement = {
      operation: 'summarize',
      subject_id: 'user-1',
      day: '2026-01-15',
      outcome: 'succeeded',
      attempts: [],
    }

    for (const reservation_id of ['', 'an\u0000id']) {
      const { controls } = createPostgresStores({
        pool: answering([{ ...settlement, reservation_id }]),
      })
      await expect(controls.readSettled('an-id')).rejects.toThrow(/could have issued/)
    }
  })

  it('refuses a settlement whose outcome is neither of the two', async () => {
    const { controls } = createPostgresStores({
      pool: answering([
        {
          reservation_id: 'an-id',
          operation: 'summarize',
          subject_id: 'user-1',
          day: '2026-01-15',
          outcome: 'perhaps',
          attempts: [],
        },
      ]),
    })

    await expect(controls.readSettled('an-id')).rejects.toThrow(/perhaps/)
  })
})

describe('the published migration hashes', () => {
  // Written at the release audit, and read here from then on: a published version's template
  // never changes, so a schema change is a new version file rather than an edit to this one.
  const LOCK_FILE = join(import.meta.dirname, '..', '..', 'fixtures', 'migrations.lock.json')

  it('match the lock file wherever there is one to match', () => {
    if (!existsSync(LOCK_FILE)) {
      expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1])
      return
    }
    const published: unknown = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    expect(published).toBeTypeOf('object')
    const hashes = published as Record<string, string>
    for (const [version, templateSha256] of Object.entries(hashes)) {
      const migration = MIGRATIONS.find((entry) => String(entry.version) === version)
      expect(migration?.templateSha256).toBe(templateSha256)
    }
  })
})

describe('what the PostgreSQL stores bind and keep', () => {
  it('binds the reading of a key that it checked, not a later one', async () => {
    const pool = recordingPool()
    let reads = 0
    const key = {
      get operation() {
        reads += 1
        return reads === 1 ? 'checked' : 'swapped'
      },
      subjectId: 'user-1',
    }

    await sent(postgresStores({ pool }).usage.reserve(key, 1))

    expect(pool.calls[0]?.params[0]).toBe('checked')
  })

  it('answers with the key it checked, not one read again afterwards', async () => {
    let reads = 0
    const key = {
      get subjectId() {
        reads += 1
        return reads === 1 ? 'checked' : 'swapped'
      },
      operation: 'summarize',
    }
    const stores = postgresStores({
      pool: {
        query: () =>
          Promise.resolve({
            rows: [
              {
                reservation_id: 'an-id',
                expires_at: '2026-01-15T12:01:00.000Z',
                day: '2026-01-15',
                resets_at: '2026-01-16T00:00:00.000Z',
                used: 1,
              },
            ],
          }),
      },
    })

    const result = await stores.usage.reserve(key, 1)

    expect(result.ok && result.reservation.key.subjectId).toBe('checked')
  })

  it('persists the reading of a route that it checked', async () => {
    const pool = recordingPool()
    let reads = 0
    const route = {
      get model() {
        reads += 1
        return reads === 1 ? 'checked' : 'swapped'
      },
      provider: 'claude',
      quota: { perDay: 5 },
    }

    await sent(postgresStores({ pool }).config.set('summarize', route))

    expect(pool.calls[0]?.params[1]).toBe(
      JSON.stringify({ provider: 'claude', model: 'checked', quota: { perDay: 5 } }),
    )
  })

  it('hands two readers of one row their own copy of it', async () => {
    // A driver is free to answer twice with the same object; one caller editing what it read
    // must not change what the next one sees.
    const rows = [{ operation: 'summarize', route: { provider: 'claude', model: 'first' } }]
    const stores = postgresStores({ pool: { query: () => Promise.resolve({ rows }) } })

    const first = (await stores.config.getAll()).summarize as { model: string }
    first.model = 'edited'
    const second = (await stores.config.getAll()).summarize as { model: string }

    expect(second.model).toBe('first')
    expect(rows[0]?.route.model).toBe('first')
  })

  it('keeps the fields a route declares and nothing else', async () => {
    const pool = recordingPool()
    const route = {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 1024,
      temperature: 0.2,
      quota: { perDay: 25 },
      fallback: { provider: 'openai', model: 'gpt-4.1-mini', maxOutputTokens: 512 },
    }

    // Held in a variable, so the extra property is not an excess-property error: this is the
    // shape a caller with a wider object really hands over.
    const wider = { ...route, extra: 'dropped' }

    await sent(postgresStores({ pool }).config.set('summarize', wider))

    expect(pool.calls[0]?.params[1]).toBe(JSON.stringify(route))
  })
})
