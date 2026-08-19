import type pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

import { MIGRATIONS, migrationSql } from '../../../src/stores/postgres/migrations'
import {
  createPool,
  describeDatabase,
  dropSchema,
  migrate,
  sqlStateOf,
  uniqueSchema,
} from './setup'

/**
 * The prefix of a migration that stopped part way through.
 *
 * The template holds no functions and no string literal carrying a semicolon, so a split at
 * `;` followed by a blank line always lands between statements. It also lands inside the
 * commented pruning block, which is why the test keeps a prefix it has checked ends after a
 * complete table rather than an arbitrary one.
 *
 * @param parts How many of those pieces to keep.
 */
function partialApply(sql: string, parts: number): string {
  return `${sql.split(';\n\n').slice(0, parts).join(';\n\n')};`
}

/** A hash of the right shape that is not the one the package publishes. */
const OTHER_HASH = 'f'.repeat(64)

describeDatabase('the packaged migration', () => {
  let pool: pg.Pool
  const schemas: string[] = []

  /** A schema of this test's own, dropped when the file is done. */
  function schemaForThisTest(): string {
    const schema = uniqueSchema('migration')
    schemas.push(schema)
    return schema
  }

  beforeAll(() => {
    pool = createPool()
  })

  afterEach(async () => {
    for (const schema of schemas) await dropSchema(pool, schema)
    schemas.length = 0
  })

  afterAll(async () => {
    await pool.end()
  })

  it('changes nothing the second time it is applied', async () => {
    const schema = schemaForThisTest()

    await migrate(pool, schema)
    await migrate(pool, schema)

    const { rows } = await pool.query<{ version: number; template_sha256: string }>(
      `SELECT version, template_sha256 FROM "${schema}".schema_migrations`,
    )
    expect(rows).toEqual([{ version: 1, template_sha256: MIGRATIONS[0]?.templateSha256 }])
  })

  it('completes when it is re-run after stopping part way through', async () => {
    const schema = schemaForThisTest()
    const { sql } = migrationSql({ schema })

    await pool.query(partialApply(sql, 4))
    const halfway = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    )
    expect(halfway.rows.map((row) => row.table_name).sort()).toEqual([
      'operation_routes',
      'schema_migrations',
      'usage_counters',
      'usage_reservations',
    ])

    await pool.query(sql)

    const finished = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    )
    expect(finished.rows.map((row) => row.table_name)).toContain('usage_settlements')
    const versions = await pool.query(`SELECT version FROM "${schema}".schema_migrations`)
    expect(versions.rows).toHaveLength(1)
  })

  it('refuses a different template for a version already applied', async () => {
    const schema = schemaForThisTest()
    const { sql } = migrationSql({ schema })
    await pool.query(sql)

    const forged = sql.replace(MIGRATIONS[0]?.templateSha256 ?? '', OTHER_HASH)

    await expect(pool.query(forged)).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === '23505',
    )
  })

  it('refuses a schema holding a table of the same name and a different shape', async () => {
    const schema = schemaForThisTest()
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE "${schema}".usage_counters (operation text)`)

    await expect(migrate(pool, schema)).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === '42703',
    )
  })

  it('refuses a table of the right shape that is missing the constraint it relies on', async () => {
    const schema = schemaForThisTest()
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(
      `CREATE TABLE "${schema}".usage_counters (
         operation text NOT NULL, subject_id text NOT NULL, day date NOT NULL,
         used integer NOT NULL, last_admitted boolean NOT NULL)`,
    )

    await expect(migrate(pool, schema)).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === '42P10',
    )
  })
})
