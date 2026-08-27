/**
 * Migration 001: the whole v0.1 schema, as one idempotent file.
 *
 * Every statement is `IF NOT EXISTS`, so applying the file twice, or re-running it after a
 * partial failure, is the same operation. `IF NOT EXISTS` matches names and not shapes, so
 * the probes at the end refuse three things it cannot see: a version 1 already applied from a
 * different template, a column that is missing or whose type cannot take the literals the
 * probe writes, and a missing primary key or unique constraint one of the statements conflicts
 * on. They are not a type check: a `bigint` where the schema says `integer` takes those
 * literals and passes, and fails at first use instead. Nor do they inspect a pre-existing
 * table's `CHECK` constraints or its index definitions. That is what the dedicated-schema
 * precondition is for. The file carries no transaction control, because migration tools differ
 * on whether they supply their own.
 *
 * @module
 */

import { createHash } from 'node:crypto'

import { DEFAULT_SCHEMA, quotedSchema } from '../identifiers'

const SCHEMA_TOKEN = '__SCHEMA__'
const HASH_TOKEN = '__TEMPLATE_SHA256__'

/**
 * The migration as it is published: schema and hash still as tokens.
 *
 * A published version never changes. A schema change is a new version file, so that an
 * adopter who has applied version 1 is never asked to apply a different version 1.
 */
const TEMPLATE = `CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

CREATE TABLE IF NOT EXISTS __SCHEMA__.schema_migrations (
  version         integer     PRIMARY KEY,
  template_sha256 text        NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, template_sha256)
);

-- Runtime config: one row per operation. The route is stored as it arrived; whether it means
-- anything is the library's question, not the schema's.
CREATE TABLE IF NOT EXISTS __SCHEMA__.operation_routes (
  operation   text        PRIMARY KEY,
  route       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Admission control: one row per (operation, subject, UTC day). This row is where a reserve
-- decides, because it is the one thing a single statement can evaluate against the latest
-- committed value.
CREATE TABLE IF NOT EXISTS __SCHEMA__.usage_counters (
  operation      text    NOT NULL,
  subject_id     text    NOT NULL,
  day            date    NOT NULL,
  used           integer NOT NULL CHECK (used >= 0),
  last_admitted  boolean NOT NULL,            -- decision of the most recent reserve; read via RETURNING only
  PRIMARY KEY (operation, subject_id, day)
);
CREATE INDEX IF NOT EXISTS usage_counters_day ON __SCHEMA__.usage_counters (day);   -- pruning

-- Ledger: one row per reservation.
CREATE TABLE IF NOT EXISTS __SCHEMA__.usage_reservations (
  reservation_id  text        PRIMARY KEY CHECK (reservation_id <> ''),
  operation       text        NOT NULL,
  subject_id      text        NOT NULL,
  day             date        NOT NULL,
  state           text        NOT NULL CHECK (state IN ('pending', 'committed', 'expired')),
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,          -- lease end; never past day + 1 00:00Z
  committed_at    timestamptz,
  fenced_at       timestamptz,                   -- stamped by a commit that answered 'expired'; never committed afterwards
  CHECK ((state = 'committed') = (committed_at IS NOT NULL)),
  CHECK (fenced_at IS NULL OR state <> 'committed'),
  CHECK (fenced_at IS NULL OR expires_at <= fenced_at)
);
-- Only pending rows are ever searched by key; committed rows are reached by id only.
CREATE INDEX IF NOT EXISTS usage_reservations_pending
  ON __SCHEMA__.usage_reservations (operation, subject_id, day, expires_at, reservation_id)
  WHERE state = 'pending';                       -- a reserve scans and locks in exactly this order
CREATE INDEX IF NOT EXISTS usage_reservations_day
  ON __SCHEMA__.usage_reservations (day);

-- Receipts: what settle() persisted. No foreign key: an unknown reservation is recorded too.
CREATE TABLE IF NOT EXISTS __SCHEMA__.usage_settlements (
  reservation_id  text        PRIMARY KEY CHECK (reservation_id <> ''),
  operation       text        NOT NULL,
  subject_id      text        NOT NULL,
  day             date        NOT NULL,
  outcome         text        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  attempts        jsonb       NOT NULL CHECK (jsonb_typeof(attempts) = 'array'),
  settled_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_settlements_day
  ON __SCHEMA__.usage_settlements (day);

-- Shape probes: IF NOT EXISTS matches names, not definitions. These fail (42703) if a
-- same-named table with a different shape already lives in this schema.
SELECT version, template_sha256, applied_at FROM __SCHEMA__.schema_migrations WHERE false;
SELECT operation, route, updated_at FROM __SCHEMA__.operation_routes WHERE false;
SELECT operation, subject_id, day, used, last_admitted FROM __SCHEMA__.usage_counters WHERE false;
SELECT reservation_id, operation, subject_id, day, state, created_at, expires_at, committed_at, fenced_at
  FROM __SCHEMA__.usage_reservations WHERE false;
SELECT reservation_id, operation, subject_id, day, outcome, attempts, settled_at
  FROM __SCHEMA__.usage_settlements WHERE false;

-- Constraint probes: a zero-row INSERT still validates its ON CONFLICT arbiter, so these
-- fail (42P10) if the primary key or unique constraint the store relies on is missing.
INSERT INTO __SCHEMA__.schema_migrations (version, template_sha256) SELECT 0, '' WHERE false
  ON CONFLICT (version) DO NOTHING;
INSERT INTO __SCHEMA__.schema_migrations (version, template_sha256) SELECT 0, '' WHERE false
  ON CONFLICT (version, template_sha256) DO NOTHING;
INSERT INTO __SCHEMA__.operation_routes (operation, route) SELECT '', '{}'::jsonb WHERE false
  ON CONFLICT (operation) DO NOTHING;
INSERT INTO __SCHEMA__.usage_counters (operation, subject_id, day, used, last_admitted)
  SELECT '', '', '2000-01-01', 0, false WHERE false ON CONFLICT (operation, subject_id, day) DO NOTHING;
INSERT INTO __SCHEMA__.usage_reservations (reservation_id, operation, subject_id, day, state, created_at, expires_at)
  SELECT 'x', '', '', '2000-01-01', 'pending', now(), now() WHERE false ON CONFLICT (reservation_id) DO NOTHING;
INSERT INTO __SCHEMA__.usage_settlements (reservation_id, operation, subject_id, day, outcome, attempts, settled_at)
  SELECT 'x', '', '', '2000-01-01', 'failed', '[]'::jsonb, now() WHERE false ON CONFLICT (reservation_id) DO NOTHING;

-- Pruning. Run it on your own schedule; llmdispatch never deletes anything itself. Batched so
-- that a busy day never becomes one huge transaction, and SKIP LOCKED so that two pruners
-- never wait on each other. Repeat each statement until it reports 0 rows.
--   DELETE FROM __SCHEMA__.usage_settlements WHERE ctid IN (
--     SELECT ctid FROM __SCHEMA__.usage_settlements
--      WHERE day <= (now() AT TIME ZONE 'UTC')::date - 2
--      ORDER BY day, reservation_id LIMIT 10000 FOR UPDATE SKIP LOCKED);
--   DELETE FROM __SCHEMA__.usage_reservations WHERE ctid IN (
--     SELECT ctid FROM __SCHEMA__.usage_reservations
--      WHERE day <= (now() AT TIME ZONE 'UTC')::date - 2
--        AND NOT (state = 'pending' AND expires_at > now())
--      ORDER BY day, reservation_id LIMIT 10000 FOR UPDATE SKIP LOCKED);
--   DELETE FROM __SCHEMA__.usage_counters WHERE ctid IN (
--     SELECT ctid FROM __SCHEMA__.usage_counters
--      WHERE day <= (now() AT TIME ZONE 'UTC')::date - 2
--      ORDER BY day, operation, subject_id LIMIT 10000 FOR UPDATE SKIP LOCKED);

-- Maintenance, needed only if your server sets statement_timeout below the time one reserve
-- needs to reclaim a very large number of lapsed reservations at once: expire them in batches
-- without admitting anything. One statement, the same lock order a reserve uses, counter exact.
--   WITH r AS (UPDATE __SCHEMA__.usage_reservations SET state = 'expired'
--                WHERE reservation_id IN (SELECT reservation_id FROM __SCHEMA__.usage_reservations
--                  WHERE operation = $1 AND subject_id = $2 AND day = $3::date
--                    AND state = 'pending' AND expires_at <= now()
--                  ORDER BY expires_at, reservation_id LIMIT 10000 FOR UPDATE)
--              RETURNING 1)
--   UPDATE __SCHEMA__.usage_counters SET used = used - (SELECT count(*) FROM r), last_admitted = false
--    WHERE operation = $1 AND subject_id = $2 AND day = $3::date;

-- Version record: re-applying the same template is a no-op; a different template for
-- version 1 fails with a unique violation (23505) instead of being silently accepted.
INSERT INTO __SCHEMA__.schema_migrations (version, template_sha256)
  VALUES (1, '__TEMPLATE_SHA256__')
  ON CONFLICT (version, template_sha256) DO NOTHING;
`

/** The hash of exactly the bytes above, over the template with both tokens still in place. */
export const templateSha256 = sha256(TEMPLATE)

/** The sha256 of some text, as the lower-case hex the schema records. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Renders the migration for one schema.
 *
 * @param opts `schema` defaults to `llmdispatch` and is validated, then quoted.
 * @returns The SQL to apply, and the hash of exactly those bytes.
 * @throws `RangeError` when the schema is not a name llmdispatch may own.
 */
export function render(opts?: { schema?: string }): { sql: string; sha256: string } {
  const schema = quotedSchema(opts?.schema ?? DEFAULT_SCHEMA)
  const sql = TEMPLATE.split(SCHEMA_TOKEN).join(schema).split(HASH_TOKEN).join(templateSha256)
  return { sql, sha256: sha256(sql) }
}
