/**
 * PostgreSQL entry point — `import { … } from 'llmswitch/postgres'`.
 *
 * The packaged migrations, and nothing else: `MIGRATIONS` is every published version with its
 * template hash, and `migrationSql()` renders them for your schema. The stores themselves are
 * exported from the root, so an application that has already migrated never loads the DDL.
 *
 * @module
 */

export { MIGRATIONS, migrationSql } from './stores/postgres/migrations'
