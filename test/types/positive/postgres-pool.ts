// @targets spec, package
//
// The pool an adopter already has is the one the package asks for: a `pg.Pool` satisfies the
// declared `query` without a cast, an adapter, or a widening of the declaration. The packaged
// migrations come from the subpath, where the DDL stays out of an application that has none.
import { Pool } from 'pg'

import { MIGRATIONS, migrationSql } from 'llmswitch/postgres'
import { postgresStores, type StorePair } from 'llmswitch'

export const stores: StorePair = postgresStores({ pool: new Pool() })

export const configured: StorePair = postgresStores({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  schema: 'llmswitch',
  leaseMs: 60_000,
})

export const sql: string = migrationSql({ schema: 'llmswitch' }).sql

export const published: { version: number; sha256: string }[] = MIGRATIONS.map((migration) => ({
  version: migration.version,
  sha256: migration.render().sha256,
}))
