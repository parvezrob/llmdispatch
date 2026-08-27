//#region src/stores/postgres/migrations/index.d.ts
/**
 * The packaged migrations (spec §6b).
 *
 * llmdispatch never runs DDL: it hands you the SQL and its hash, and you apply it with whatever
 * tool you already use. The hash a version records is the hash of its template — the schema
 * placeholder still in place — so two adopters using different schema names still agree on
 * which version 1 they applied.
 *
 * @module
 */
/** Every published migration, in the order they are applied. */
declare const MIGRATIONS: readonly {
  /** Which migration this is; the number the schema records. */
  version: number;
  /** The hash of the template, schema placeholder still in place. */
  templateSha256: string;
  /**
   * Renders this migration for one schema.
   *
   * @param opts `schema` defaults to `llmdispatch` and is validated, then quoted.
   * @returns The SQL to apply, and the hash of exactly those bytes.
   * @throws `RangeError` when the schema is not a name llmdispatch may own.
   */
  render(opts?: {
    schema?: string;
  }): {
    sql: string;
    sha256: string;
  };
}[];
/**
 * Every migration rendered for one schema and concatenated in version order, with the sha256
 * of exactly the bytes it hands back.
 *
 * @param opts `schema` defaults to `llmdispatch` and is validated, then quoted.
 * @throws `RangeError` when the schema is not a name llmdispatch may own.
 */
declare function migrationSql(opts?: {
  schema?: string;
}): {
  sql: string;
  sha256: string;
};
//#endregion
//#region src/stores/postgres/sql.d.ts
/**
 * Every statement the PostgreSQL stores send, built once per schema.
 *
 * Each one is a single command, so the pool runs it in a transaction of its own — which is
 * what makes a reserve atomic without the store ever pinning a connection (spec §4). Values
 * are always bound; the only thing spliced into the text is the validated schema identifier.
 *
 * @module
 */
/**
 * What marks a statement whose last parameter is the store's clock override.
 *
 * Test harnesses that can only reach the store through an adopter-shaped pool recognise the
 * four usage statements by this prefix and substitute that trailing `null`.
 */
declare const USAGE_STORE_MARKER = "/* llmdispatch:usage-store */";
//#endregion
export { MIGRATIONS, USAGE_STORE_MARKER, migrationSql };
//# sourceMappingURL=postgres.d.ts.map