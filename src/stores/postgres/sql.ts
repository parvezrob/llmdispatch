/**
 * Every statement the PostgreSQL stores send, built once per schema.
 *
 * Each one is a single command, so the pool runs it in a transaction of its own, which is
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
export const USAGE_STORE_MARKER = '/* llmdispatch:usage-store */'

/** The four statements of the usage protocol. */
export interface UsageStatements {
  reserve: string
  commit: string
  settle: string
  snapshot: string
}

/** The three statements of the route store. */
export interface ConfigStatements {
  getAll: string
  set: string
  delete: string
}

/** Statements no store method sends: the seams the internal factory's controls are built on. */
export interface ControlStatements {
  truncate: string
  readSettled: string
  inspect: string
}

/**
 * Builds the usage statements for one schema.
 *
 * @param schema The quoted schema identifier.
 */
export function usageStatements(schema: string): UsageStatements {
  return {
    // $1 operation  $2 subject_id  $3 limit  $4 lease_ms  $5 clock override
    reserve: `${USAGE_STORE_MARKER}
WITH p AS (
  SELECT $1::text AS operation, $2::text AS subject_id, $3::int AS lim,
         COALESCE($5::timestamptz, now()) AS ts
), d AS (
  SELECT (p.ts AT TIME ZONE 'UTC')::date AS day,
         (((p.ts AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS resets_at
  FROM p
), reclaimed AS (                                   -- (a) lapsed pending rows of this key/day -> expired
  UPDATE ${schema}.usage_reservations r SET state = 'expired'
  WHERE r.reservation_id IN (
    SELECT r2.reservation_id FROM ${schema}.usage_reservations r2   -- parameters inlined (not via p/d) so the
    WHERE r2.operation = $1::text AND r2.subject_id = $2::text      -- planner can prove the index order: no Sort
      AND r2.day = (COALESCE($5::timestamptz, now()) AT TIME ZONE 'UTC')::date
      AND r2.state = 'pending' AND r2.expires_at <= COALESCE($5::timestamptz, now())
    ORDER BY r2.expires_at, r2.reservation_id                       -- fixed lock order = pending index order
    FOR UPDATE
  )
  RETURNING 1
), freed AS (SELECT count(*)::int AS n FROM reclaimed),
counter AS (                                        -- (b) unconditional: persist the reclaim, decide admission
  INSERT INTO ${schema}.usage_counters AS c (operation, subject_id, day, used, last_admitted)
  SELECT p.operation, p.subject_id, d.day,
         CASE WHEN p.lim > 0 THEN 1 ELSE 0 END, p.lim > 0
  FROM p, d, freed                                  -- joining "freed" forces (a) to finish before (b) locks
  ON CONFLICT (operation, subject_id, day) DO UPDATE
    SET used = c.used - (SELECT n FROM freed)
               + CASE WHEN c.used - (SELECT n FROM freed) < (SELECT lim FROM p) THEN 1 ELSE 0 END,
        last_admitted = (c.used - (SELECT n FROM freed) < (SELECT lim FROM p))
  RETURNING used, last_admitted
), g AS (                                           -- (c) grant time: taken after the counter lock, capped at the day end
  SELECT LEAST(COALESCE($5::timestamptz, clock_timestamp()), d.resets_at) AS granted_at
  FROM counter, d WHERE last_admitted
), ins AS (                                         -- (d) the reservation row, only if (b) admitted
  INSERT INTO ${schema}.usage_reservations (reservation_id, operation, subject_id, day, state, created_at, expires_at)
  SELECT gen_random_uuid()::text, p.operation, p.subject_id, d.day, 'pending', g.granted_at,
         LEAST(g.granted_at + make_interval(secs => $4::int / 1000.0), d.resets_at)
  FROM p, d, g
  RETURNING reservation_id, expires_at
)
SELECT ins.reservation_id,
       to_char(ins.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
       to_char(d.day, 'YYYY-MM-DD')                                             AS day,
       to_char(d.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')  AS resets_at,
       (SELECT used FROM counter)                                                AS used
FROM d LEFT JOIN ins ON true`,

    // $1 reservation_id  $2 clock override
    commit: `${USAGE_STORE_MARKER}
WITH p AS (SELECT $1::text AS id, COALESCE($2::timestamptz, now()) AS ts),
upd AS (
  UPDATE ${schema}.usage_reservations r
     SET state = CASE WHEN r.state = 'committed'
                        OR (r.state = 'pending' AND r.fenced_at IS NULL AND r.expires_at > p.ts)
                      THEN 'committed' ELSE r.state END,
         committed_at = CASE WHEN r.state = 'committed' THEN r.committed_at
                             WHEN r.state = 'pending' AND r.fenced_at IS NULL AND r.expires_at > p.ts THEN p.ts
                             ELSE r.committed_at END,
         fenced_at = CASE WHEN r.state = 'pending' AND (r.fenced_at IS NOT NULL OR r.expires_at <= p.ts)
                          THEN COALESCE(r.fenced_at, p.ts) ELSE r.fenced_at END   -- 'expired' is final; expires_at untouched
    FROM p
   WHERE r.reservation_id = p.id                       -- id only: always lock, always re-evaluate
  RETURNING (r.state = 'committed') AS committed        -- r.* here is the new row
)
SELECT COALESCE((SELECT CASE WHEN committed THEN 'committed' ELSE 'expired' END FROM upd), 'missing') AS result`,

    // $1 reservation_id  $2 operation  $3 subject_id  $4 day  $5 outcome  $6 attempts  $7 clock override
    settle: `${USAGE_STORE_MARKER}
INSERT INTO ${schema}.usage_settlements (reservation_id, operation, subject_id, day, outcome, attempts, settled_at)
VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, COALESCE($7::timestamptz, now()))
ON CONFLICT (reservation_id) DO NOTHING`,

    // $1 operation  $2 subject_id  $3 clock override
    snapshot: `${USAGE_STORE_MARKER}
WITH p AS (SELECT $1::text AS operation, $2::text AS subject_id, COALESCE($3::timestamptz, now()) AS ts),
d AS (SELECT (p.ts AT TIME ZONE 'UTC')::date AS day,
             (((p.ts AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS resets_at FROM p)
SELECT GREATEST(0,
         COALESCE((SELECT c.used FROM ${schema}.usage_counters c, p
                    WHERE c.operation = p.operation AND c.subject_id = p.subject_id AND c.day = d.day), 0)
         - (SELECT count(*)::int FROM ${schema}.usage_reservations r, p
             WHERE r.operation = p.operation AND r.subject_id = p.subject_id AND r.day = d.day
               AND r.state = 'pending' AND r.expires_at <= p.ts)) AS used,
       to_char(d.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resets_at
FROM d`,
  }
}

/**
 * Builds the route-store statements for one schema.
 *
 * @param schema The quoted schema identifier.
 */
export function configStatements(schema: string): ConfigStatements {
  return {
    getAll: `SELECT operation, route FROM ${schema}.operation_routes`,
    // $1 operation  $2 route
    set: `INSERT INTO ${schema}.operation_routes (operation, route, updated_at) VALUES ($1, $2::jsonb, now())
ON CONFLICT (operation) DO UPDATE SET route = EXCLUDED.route, updated_at = now()`,
    // $1 operation
    delete: `DELETE FROM ${schema}.operation_routes WHERE operation = $1`,
  }
}

/**
 * Builds the statements behind the internal factory's controls.
 *
 * @param schema The quoted schema identifier.
 */
export function controlStatements(schema: string): ControlStatements {
  return {
    truncate: `TRUNCATE ${schema}.usage_counters, ${schema}.usage_reservations,
${schema}.usage_settlements, ${schema}.operation_routes`,
    // $1 reservation_id
    readSettled: `SELECT reservation_id, operation, subject_id, to_char(day, 'YYYY-MM-DD') AS day,
       outcome, attempts
  FROM ${schema}.usage_settlements WHERE reservation_id = $1`,
    // $1 operation  $2 subject_id  $3 day
    inspect: `SELECT (SELECT count(*)::int FROM ${schema}.usage_reservations r
                  WHERE r.operation = $1 AND r.subject_id = $2 AND r.day = $3::date) AS reservations,
       c.used, c.last_admitted
  FROM (VALUES (1)) AS one(n)
  LEFT JOIN ${schema}.usage_counters c
    ON c.operation = $1 AND c.subject_id = $2 AND c.day = $3::date`,
  }
}
