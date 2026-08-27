/**
 * PostgreSQL entry point — `import { … } from 'llmswitch/postgres'`.
 *
 * The packaged migrations: `MIGRATIONS` is every published version with its template hash, and
 * `migrationSql()` renders them for your schema. The stores themselves are exported from the
 * root, so an application that has already migrated never loads the DDL.
 *
 * `USAGE_STORE_MARKER` is published here too. A conformance harness that reaches the packaged
 * store through a pool of its own has to recognise the store's usage statements to drive their
 * clock (spec §6b), and reading that marker out of the source of an installed package is not
 * something an adopter should have to do.
 *
 * @module
 */

export { MIGRATIONS, migrationSql } from './stores/postgres/migrations'
export { USAGE_STORE_MARKER } from './stores/postgres/sql'
