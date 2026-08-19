/**
 * What every PostgreSQL suite needs: a pool, a schema of its own, and the migration applied.
 *
 * Each file works in a schema named after itself plus a random suffix, so two files — or two
 * runs — never share a table. `DATABASE_URL` is what decides whether these suites run at all:
 * absent locally they are skipped with the reason in the suite's name, and absent in CI they
 * fail, because a workflow that lost its database must not report a green skipped suite.
 */

import pg from 'pg'
import { describe } from 'vitest'

import { migrationSql } from '../../../src/stores/postgres/migrations'

const DATABASE_URL = process.env.DATABASE_URL ?? ''

/** Whether a database was named for this run. */
export const hasDatabase = DATABASE_URL !== ''

if (!hasDatabase && (process.env.CI ?? '') !== '') {
  throw new Error('DATABASE_URL is not set: the PostgreSQL suites cannot be skipped in CI')
}

/** Runs a suite against the database, or skips it saying why. */
export function describeDatabase(name: string, body: () => void): void {
  if (hasDatabase) describe(name, body)
  else describe.skip(`${name} (skipped: DATABASE_URL is not set)`, body)
}

/**
 * A pool on the database under test.
 *
 * @param config Anything to add to the connection, such as an isolation level.
 */
export function createPool(config: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, ...config })
}

/** A schema name of this run's own, in the shape the identifier rule accepts. */
export function uniqueSchema(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** Applies the packaged migration, rendered for one schema. */
export async function migrate(pool: pg.Pool, schema: string): Promise<void> {
  await pool.query(migrationSql({ schema }).sql)
}

/** Removes a schema and everything the migration put in it. */
export async function dropSchema(pool: pg.Pool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
}

/** The code a driver error carries, or `null` for anything that is not one. */
export function sqlStateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}
