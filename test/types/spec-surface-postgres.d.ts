// Generated from the code fences of docs/spec.md by scripts/check-spec-surface.mjs.
// Edit the spec, then run `npm run surface:update`.

// subpath: llmswitch/postgres
export declare const MIGRATIONS: ReadonlyArray<{
  version: number
  templateSha256: string                                  // hash of the canonical template (schema placeholder form)
  render(opts?: { schema?: string }): { sql: string; sha256: string }  // hash of the exact rendered bytes
}>
// All versions concatenated in order, idempotent, schema-rendered; sha256 covers the
// exact aggregate sql bytes.
export declare function migrationSql(opts?: { schema?: string }): { sql: string; sha256: string }
