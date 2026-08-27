/**
 * The schema identifier rule, and the one place a name reaches SQL text.
 *
 * Parameters are always bound; the schema cannot be, so it is checked against a narrow
 * pattern and always rendered double-quoted.
 *
 * @module
 */

/** Lower case only, so quoting behaves the same in every tool that touches the schema. */
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/

/** The schema `postgresStores()` and `render()` use when the caller names none. */
export const DEFAULT_SCHEMA = 'llmdispatch'

/**
 * Checks a schema name llmdispatch may own.
 *
 * @param schema The name as the caller supplied it.
 * @throws `RangeError` for anything that is not a string, for anything outside
 * `[a-z_][a-z0-9_]{0,62}`, for `information_schema`, and for the `pg_` prefix PostgreSQL
 * reserves for itself.
 */
export function assertSchema(schema: string): void {
  // Checked before anything reads it: an object carrying its own `startsWith` and `toString`
  // could otherwise answer one thing here and spell another into the SQL text.
  if (typeof schema !== 'string') throw new RangeError('schema must be a string')
  if (
    !SCHEMA_PATTERN.test(schema) ||
    schema.startsWith('pg_') ||
    schema === 'information_schema'
  ) {
    throw new RangeError(
      'schema must be 1–63 lower-case letters, digits or underscores, must not start with a ' +
        'digit or "pg_", and must not be "information_schema"',
    )
  }
}

/**
 * Checks a schema name and returns it quoted, ready to be spliced into SQL text.
 *
 * @param schema The name as the caller supplied it.
 * @throws `RangeError` when the name is not one llmdispatch may own.
 */
export function quotedSchema(schema: string): string {
  assertSchema(schema)
  return `"${schema}"`
}
