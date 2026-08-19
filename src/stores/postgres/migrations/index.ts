/**
 * The packaged migrations (spec §6b).
 *
 * llmswitch never runs DDL: it hands you the SQL and its hash, and you apply it with whatever
 * tool you already use. The hash a version records is the hash of its template — the schema
 * placeholder still in place — so two adopters using different schema names still agree on
 * which version 1 they applied.
 *
 * @module
 */

import { render, sha256, templateSha256 } from './001-initial'

/** Every published migration, in the order they are applied. */
export const MIGRATIONS: readonly {
  /** Which migration this is; the number the schema records. */
  version: number
  /** The hash of the template, schema placeholder still in place. */
  templateSha256: string
  /**
   * Renders this migration for one schema.
   *
   * @param opts `schema` defaults to `llmswitch` and is validated, then quoted.
   * @returns The SQL to apply, and the hash of exactly those bytes.
   * @throws `RangeError` when the schema is not a name llmswitch may own.
   */
  render(opts?: { schema?: string }): { sql: string; sha256: string }
}[] = Object.freeze([Object.freeze({ version: 1, templateSha256, render })])

/**
 * Every migration rendered for one schema and concatenated in version order, with the sha256
 * of exactly the bytes it hands back.
 *
 * @param opts `schema` defaults to `llmswitch` and is validated, then quoted.
 * @throws `RangeError` when the schema is not a name llmswitch may own.
 */
export function migrationSql(opts?: { schema?: string }): { sql: string; sha256: string } {
  const sql = MIGRATIONS.map((migration) => migration.render(opts).sql).join('\n')
  return { sql, sha256: sha256(sql) }
}
