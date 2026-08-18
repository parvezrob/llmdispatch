/**
 * PostgreSQL entry point — `import { … } from 'llmswitch/postgres'`.
 *
 * Kept separate from the root so that an application using the in-memory stores never
 * pulls in the SQL surface. It will export the PostgreSQL-backed config and usage
 * stores plus the packaged migrations, which you apply yourself: the package ships the
 * SQL and its checksum, and never runs DDL on your database.
 *
 * The exact surface is specified in `docs/spec.md` §6b. Nothing is exported yet — the
 * package is pre-release and the implementation lands before the first publish.
 *
 * @module
 */

export {}
