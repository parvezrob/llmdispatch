# llmdispatch v0.1 — Normative Specification

This document is the exact contract for llmdispatch v0.1. The [README](../README.md) is the
introduction; when they disagree, this spec wins. §8 defines the adopter-facing conformance
suite; the core's own behavior (state machine, matrices, sanitization, type inference) is
enforced by the package's internal test suite, including compile-time positive and negative
type fixtures (which include the exact README quickstart shape).

Status: **pre-release contract for v0.1** — the design is final; the implementation is under
active development and not yet on npm. Semver: while on 0.x, breaking changes to anything
here bump the minor version.

---

## 1. The canonical run state machine

Every `ai.run(operation, args, options?)` executes these stages in this exact order.

**Abort rule.** The caller's signal is checked at every stage boundary, before every quota
recovery I/O, and immediately before provider dispatch. Every awaited user callback and
resolver (`input.parseAsync`, API-key resolvers, `prepare()`, `prompt`, `output.parseAsync`,
`quality`) is **raced against the signal** (`raceWithAbort`): on abort the core stops
waiting, the losing promise's eventual rejection is suppressed, and the run ends `ABORTED`.
The only exception: an in-flight `reserve`/`commit` call is awaited to its
(deadline-bounded) result first — those have side effects — then the run ends `ABORTED`
without dispatching. Quota effect of an abort: whatever state was reached stands (nothing /
pending-expires / committed counts). An abort arriving **after** a successful attempt does
not change the outcome: the run returns its result; settlement records `succeeded`.

| # | Stage | Failure → code | Quota effect |
|---|---|---|---|
| 0 | Signal already aborted | `ABORTED` | none |
| 1 | Operation lookup (JS callers can pass unknown names) | `INVALID_INPUT` | none |
| 2 | Input parse: `input.parseAsync(args.input)`. `ZodError` = validation failure; a **non-Zod exception from user transform code passes through unwrapped** (pre-quota user bug) | `INVALID_INPUT` | none |
| 3 | Subject check for a **declared** quota: an operation whose definition declares `quota` requires non-empty `subjectId` | `MISSING_SUBJECT` | none |
| 4 | Config resolution (§2) — primary **and** fallback route — then, if the effective route enables a quota the definition does not declare, the same subject check | `INVALID_CONFIG` / `CONFIG_STORE_UNAVAILABLE` / `MISSING_SUBJECT` | none |
| 5 | Readiness for **both** routes (§5a): registration + `prepare()` per unique provider | `INVALID_CONFIG` (`detectedAt:'local'`; `retryable` per §5a) | none |
| 6 | Prompt build: `prompt(parsedInput)` (raced with abort). A non-string return is a user bug: descriptive `TypeError` passes through unwrapped | user exception unwrapped | none |
| 7 | Quota reserve (§4), performed iff the run has an **effective** quota (§2) | `QUOTA_EXCEEDED` / `USAGE_STORE_UNAVAILABLE` | pending reservation (envelope held) |
| 8 | Quota commit (§4 recovery table; same condition as 7; signal checked before each recovery I/O) | `QUOTA_EXCEEDED` (denied re-reserve) / `USAGE_STORE_UNAVAILABLE` | committed on success; §4 table otherwise |
| 9 | Primary attempt: final signal check → dispatch via prepared dispatcher → output pipeline (§3) | classified per §5 | committed |
| 10 | Fallback decision (§5) and, if eligible and configured, the fallback attempt (same sub-stages, fresh provider timeout) | terminal code per §5 | same slot — never a second reservation |
| 11 | **Finalization (try/finally, before every post-commit return or throw):** settle (§4), then return/throw | settlement never changes the outcome | accounting only |

Fixed rules:

- Quota work happens after config and readiness — local misconfiguration of either route
  never consumes quota.
- **Subject-check precedence.** Stage 3 covers only a *declared* quota, so that check stays
  ahead of all I/O. A quota that only the effective route enables is unknown until the route
  resolves, so its check runs immediately after stage 4: for such an operation a config
  failure or a malformed/unresolvable route (stage 4 reads the store, up to 5 s) is reported
  **before** `MISSING_SUBJECT`. The stage numbering is unchanged — this is a sub-step of 4.
- `INVALID_CONFIG` also arises **post-dispatch** (provider rejects credentials/model;
  `detectedAt:'provider'`). The slot stays committed.
- Unwrapped user exceptions (stages 2/6 pre-quota; `output_schema_error`/`quality_error`
  post-dispatch) propagate as the user's raw error, carrying no `attempts` field —
  post-dispatch ones are settled first with their attempt records.
- Crash between stages 8 and 9 leaves a committed slot with no provider call — the
  deliberate conservative window.

## 2. Config resolution (stage 4)

Per-operation resolution matrix:

| Cache state | Store read | Row | Result | Cached? |
|---|---|---|---|---|
| fresh (age < TTL; `configTtlMs: 0` disables reuse entirely) | not attempted | — | cached effective route | already |
| stale/absent | success | valid row | row is effective | yes |
| stale/absent | success | malformed row | `INVALID_CONFIG` (isolated to this operation) | not cached — re-read next run |
| stale/absent | success | no row | `defaultRoute` if declared (negative-cached as effective), else `INVALID_CONFIG` | yes |
| stale/absent | failure/timeout | unknown | `CONFIG_STORE_UNAVAILABLE` — **`defaultRoute` is never an outage fallback** | no |

- The `getAll()` return itself is validated first: a non-record (null, array, primitive)
  → `CONFIG_STORE_UNAVAILABLE` (fail-closed — a malformed container must never read as
  "no rows" and activate defaults). Rows are then validated strictly (unknown fields →
  malformed). A shape-valid row referencing an unregistered provider is malformed for
  resolution (`INVALID_CONFIG`, isolated), as is a row whose `quota` fails its §6 validation
  (shape or range). In `getConfig()`, a malformed row reports `stored: 'malformed'`,
  `effective: null`.
- **Effective quota.** The effective quota is the effective route's `quota` if the route
  carries one, else the operation's declared `quota` (§6); the effective route is the stored
  row when one resolves, else `defaultRoute`. Explicitly: a stored row **without** `quota`
  does **not** inherit `defaultRoute.quota` — it falls back to the declared quota, and the
  operation runs with no quota at all if the definition declares none. A stored `quota` on an
  operation that declares none *enables* a quota (the row is valid, and the subject
  requirement then applies, checked after stage 4 per §1). `resetConfig` deletes the row, so
  `defaultRoute` and its `quota` apply again. A run's effective quota is fixed at stage 4 (§4).
- **Cache coherence:** generation counter; every mutation outcome (success, timeout,
  rejection — any outcome whose non-application is not positively known) bumps the
  generation and invalidates locally. A read begun under an older generation cannot
  overwrite a newer entry. **Mutation ordering:** the core serializes config mutations
  per operation within a process (one in flight, FIFO); the mutex is RELEASED at the
  caller deadline (ConfigStore has no cancellation contract), so a timed-out write may
  still land late and overwrite a subsequent write — in-process as well as cross-process.
  This is the documented last-write-wins/unknown-ack limitation; the deferred CAS/revision
  mechanism (v0.2, settled) is the full fix. Custom ConfigStores must give the writing client
  read-your-writes.
- Admin method matrix (operation name validated first; unknown → `INVALID_INPUT`):

  | Method | Store call | Deadline | Failure → | Cache effect |
  |---|---|---|---|---|
  | `getConfig()` | `getAll` | 5s | `CONFIG_STORE_UNAVAILABLE` | none (bypasses) |
  | `setConfig(op, route)` | `set` | 10s | `CONFIG_STORE_UNAVAILABLE` (retryable; unknown-ack) | invalidate + bump on every outcome |
  | `resetConfig(op)` | `delete` | 10s | same | same |
  | `getQuota(op, subjectId)` | config resolution, then `snapshot` | 5s + 10s | `INVALID_INPUT` / `CONFIG_STORE_UNAVAILABLE` / `INVALID_CONFIG` / `USAGE_STORE_UNAVAILABLE` (precedence below) | as the resolution matrix above (cache honoured and updated) |

- `getConfig()` returns per operation `{ stored: OperationRoute | null | 'malformed',
  effective: OperationRoute | null }` (readiness not probed).
- `setConfig` replace-only, validated (shape, registered provider IDs, §6 ranges — including
  `quota.perDay`). Cache TTL default 5000ms (`configTtlMs`, 0–300 000; `0` = read every run).
- `getQuota` resolves the operation's config before reading usage, because the limit it
  reports is the **effective** limit and may live on the route. Full precedence: unknown
  operation → `INVALID_INPUT`; empty `subjectId` → `INVALID_INPUT`; config resolution failure
  → `CONFIG_STORE_UNAVAILABLE`, `snapshot` not attempted; malformed row, or no row and no
  `defaultRoute` → `INVALID_CONFIG` (an operation whose limit is declared in code still needs
  a resolvable route); no effective quota → `INVALID_INPUT`; otherwise `snapshot`, whose
  failure or timeout maps to `USAGE_STORE_UNAVAILABLE` as before. A fresh cache entry makes
  the resolution free; the two deadlines are sequential (§6a).

## 3. Output pipeline (attempt sub-stages)

1. Each operation declares `format`: **`'json'`** (default — top-level JSON **object**),
   **`'json-any'`** (arbitrary JSON — native provider JSON modes never enabled), or
   **`'text'`**. No schema introspection: text-shaped output schemas MUST set `'text'`.
2. The adapter receives `responseFormat: { type: 'text' } | { type: 'json'; topLevel:
   'object' | 'any' }` and enables native generic JSON mode only per its §5c capability
   rule AND `topLevel: 'object'`. Schema-constrained structured output is NOT v0.1;
   the prompt carries the shape.
3. **Termination is checked before content**: adapters normalize termination metadata
   into `ProviderResponse.kind` (§5c). `'truncated'` classifies `truncated`; `'refused'`
   classifies `refused`; unknown terminal states are the ADAPTER'S job to map (unmappable →
   throw `ProviderError('malformed_response')`). Only `kind: 'complete'` proceeds.
4. `text`: raw text → `output.parseAsync`. `json`/`json-any`: unwrap a single
   whole-response code fence if present → `JSON.parse` → **for `'json'`, the parsed value
   must be a non-null, non-array object** (else output rejection) → `output.parseAsync`.
5. `JSON.parse` failure, object-shape failure, or `ZodError` → output rejection
   (fallback-eligible). A non-Zod exception from user transform code → `output_schema_error`
   (settled, unwrapped, no fallback).
6. Quality gate: `quality({ input, data })` (raced with abort). `{ ok:false }` → output
   rejection. A malformed verdict (neither `{ok:true}` nor `{ok:false,...}`) or a thrown
   exception → `quality_error` (settled, unwrapped, no additional fallback spend).
7. `run` accepts `z.input` of the input schema; `prompt` receives `z.output` of the input
   schema; `result.data` is `z.output` of the output schema. Async schemas supported.
8. **`timeoutMs` is the provider I/O timeout** (races `Provider.complete()` only); output
   processing is bounded by the abort race. Fallback gets a fresh `timeoutMs`.

## 4. Quota lifecycle and UsageStore contract

One **run** = one slot, shared with its fallback attempt. The **store's clock owns the UTC
day**. `reserve()` returns the store-created immutable **`ReservationEnvelope`** —
`{ reservationId, key, day }` with `day` as `YYYY-MM-DD` (UTC, chosen by the store; years
0001–9999 — year 0000 is invalid, because PostgreSQL has no year zero where JavaScript
would accept it, and substitutability requires the shared bound) — which
the core validates (`key` must equal the requested key; `day` must match the domain) and
carries verbatim through commit recovery and settlement. A re-reservation **replaces** the
active envelope.

- **reserve** — the `limit` passed is the run's **effective limit** (§2). The store atomically
  counts committed + unexpired pending slots for the store's current UTC day (`used`) and
  admits iff `used < limit`: insert pending reservation, lease
  `expiresAt = min(now + leaseMs, resetsAt)` (a lease never crosses the day boundary).
  A denial's `used` is authoritative for that `reserve`'s own snapshot-and-lock point: it is
  never lower than live usage, and it exceeds live usage only by rows that lapsed or appeared
  while that `reserve` waited for the counter.
  **`limit === 0`:** the core **still calls `reserve`** and never short-circuits — `used` and
  `resetsAt` must be store-authoritative. An available store returns the complete denial
  `{ ok: false, used, resetsAt }` — `used` being the day's authoritative count, which may be
  non-zero — **without inserting a reservation**, and the run ends `QUOTA_EXCEEDED`; a
  transport error or timeout still maps to `USAGE_STORE_UNAVAILABLE`, so a zero limit during
  a store outage refuses as an outage, not as a quota denial. `getQuota` at zero
  returns `limit: 0`, `remaining: 0`, and that same authoritative `used`. How quickly a
  newly written zero takes effect follows the cache rule below (5).
- **commit** is idempotent, conditional: pending-and-unexpired → `'committed'`; already
  committed → `'committed'` (lost-ack recovery); expired → `'expired'`; unknown →
  `'missing'`.
- **Commit recovery (bounded; signal checked before each step):**

  | Commit result | Core action |
  |---|---|
  | `'committed'` | dispatch |
  | `'expired'` | re-reserve **once** (new envelope): `{ok:true}` → commit the new id (`'expired'`/`'missing'` again → `USAGE_STORE_UNAVAILABLE`); `{ok:false}` → `QUOTA_EXCEEDED` with its `resetsAt` |
  | `'missing'` | `USAGE_STORE_UNAVAILABLE` |
  | transport error/timeout | retry same id ×3 (250/500/1000ms) → `USAGE_STORE_UNAVAILABLE` ("possibly committed" — conservative) |

- **settle(envelope, outcome, attempts)** — idempotent, atomic per reservation: exact
  duplicate → no-op; conflicting payload after settlement → ignored (first write wins);
  pending/expired/**unknown** reservation → record attempts against the envelope's
  key/day without changing slot accounting. Attempt order = dispatch order.
- **Settlement execution (v0.1, non-durable):** initial `settle` awaited (10s deadline)
  in finalization — settlement failure never changes an otherwise successful outcome,
  though delivery may be delayed by up to that deadline; then up to 3 detached retries
  (1s/5s/25s, same per-attempt deadline); remaining failure →
  `onSettlementError(error, { reservation, outcome, attempts })` invoked through an
  awaited, caught promise chain (async hooks contained; throwing/rejecting hooks and
  loggers are caught and dropped). Exit-before-retry loses attempt records, never slot
  accounting.
- **snapshot** returns store-authoritative `{ used, resetsAt }`; `used` includes unexpired
  pending reservations.
- **Store-result validation (fail-closed):** every store return is validated at runtime
  (envelope shape/key match/day format, commit strings, snapshot numbers as non-negative
  **safe** integers, timestamps parseable). Malformed results map to the corresponding
  `*_UNAVAILABLE` error; the core never dispatches without a validated `'committed'`.

**Changing a limit while runs are in flight.** A limit is part of config (§2), so it can be
edited between one run and the next:

1. A run captures its effective limit at config resolution (stage 4). A later change never
   alters that run's pending envelope, its commit recovery, or an in-flight re-reservation —
   those complete against the captured limit.
2. A limit lowered to at or below the day's current `used` denies **new** reservations
   (`QUOTA_EXCEEDED` with the store's `resetsAt`); already-committed slots stand.
3. `getQuota` may therefore report `used > limit` with `remaining: 0`, since `remaining` is
   `max(0, limit - used)`.
4. Removing the only quota — clearing `quota` from a stored row for an operation whose
   definition declares none — makes new runs non-quota and `getQuota` return `INVALID_INPUT`;
   reservations already pending or committed keep their normal lifecycle (expiry, commit,
   settle, pruning) and their rows are untouched.
5. Any change, including to 0, applies to new runs once it is cache-visible per §2, and never
   to already-resolved work. This is not an upper bound: once a write is visible
   to store reads, the core may still serve a stale result for one `configTtlMs` after the
   read that preceded the write completes (that read may itself run to its 5 s deadline); an
   external write does not bump another process's generation (§2, cache coherence), and
   cross-process store visibility has no core-guaranteed wall-clock bound.

Postgres adapter: single-statement atomic reserve/commit (row-level concurrency, no
explicit table-wide locks), lease and day boundary enforced in SQL, schema-qualified
identifiers, default `leaseMs` 120 000 (5 000–600 000). Every method sends one command, so
each call runs in a transaction of its own; the pool must run at READ COMMITTED
(PostgreSQL's default) — under REPEATABLE READ or SERIALIZABLE, concurrent reserves abort
with a serialization failure instead of one being denied: fail-closed, never
over-admitting. Migrations are packaged (§6b), schema-aware, and never auto-run.

**Persisted data (privacy boundary):** operation, `subjectId` (verbatim), UTC day,
reservation state, timestamps, and the complete `AttemptRecord` fields per attempt
(provider, model, outcome, status, token counts, `costUsd`, `durationMs`) — so settle
round-trip/duplicate detection is defined over whole records.
Never prompts, inputs, outputs, or raw errors. **Pruning:** prune **settled** rows ≥ 2 days
past their day; committed-but-unsettled rows retained until 24h past their day, then
prunable; never prune unexpired pending rows. The migration ships a `DELETE` example
implementing exactly this.

## 5. Failure classification, fallback, and `retryable`

### 5a. Readiness lifecycle

- **Registration (`createSwitch`):** registration is the whole static check. Built-ins are
  fetch-based and dependency-free by design.
- **Stage 5 (per run, before quota):** both routes' providers must be registered. If a
  provider declares **`prepare()`** (§6), it is invoked (raced with abort) **once per
  unique provider registration ID per run** — memoized, so a run whose primary and
  fallback share a provider gets one snapshot — returning a run-scoped dispatcher used
  for that run's attempts (nothing stored on the shared provider; concurrent runs are
  isolated). A malformed return (no `complete` function) → `INVALID_CONFIG` (local).
  Built-in factories implement `prepare()` to resolve their `apiKey` (empty/undefined →
  failure). **Failure mapping:** a `prepare()` that throws `ProviderError('transient')`
  (e.g. a secrets service briefly down) → `INVALID_CONFIG` with `detectedAt:'local'`,
  **`retryable: true`**; any other failure → `retryable: false`. No quota consumed either
  way. `prepare` is public; built-ins have no private powers.
- **Post-dispatch:** provider rejects credential/model → `auth`/`model_not_found` →
  `INVALID_CONFIG` (`detectedAt:'provider'`), slot committed. Neither classification is
  fallback-eligible unless `fallbackOnAuthOrModelNotFound` (§6) is on, and the flag governs
  a **primary** attempt only — it never introduces a second fallback and does not touch the
  local `INVALID_CONFIG` paths above. `detectedAt` is a property of the thrown
  `LLMDispatchError`, never of an `AttemptRecord` (§6), and `detectedAt:'provider'` is set only
  when the terminal code is `INVALID_CONFIG` from the final attempt: a primary rescued by its
  fallback contributes an attempt record with outcome `auth`/`model_not_found` and the run
  raises no error at all, while a fallback that itself ends `auth`/`model_not_found` is
  terminal, so the run throws `INVALID_CONFIG` with `detectedAt:'provider'`.

### 5b. Classification table (exhaustive) with literal `retryable`

| Classification | Fallback? | Terminal code if final | `retryable` |
|---|---|---|---|
| `transient` (network, 5xx, 408, overload) | ✅ | `PROVIDER_FAILED` | `true` |
| `rate_limit` (429; billing-exhaustion via 429/402 included — cross-provider fallback is the remedy) | ✅ | `PROVIDER_FAILED` | `true` |
| `malformed_response` (unusable body/shape/unknown terminal state) | ✅ | `PROVIDER_FAILED` | `true` |
| `timeout` (core-assigned) | ✅ | `PROVIDER_FAILED` | `true` |
| `truncated` (`ProviderResponse.kind: 'truncated'` — max-token/length/context termination per §5c) | ✅ | `OUTPUT_REJECTED` | `true` |
| `output_rejected` (JSON parse / object-shape / `ZodError` / quality `{ok:false}`) | ✅ | `OUTPUT_REJECTED` | `true` |
| `refused` (`ProviderResponse.kind: 'refused'` — refusal/safety/policy block on a 200 per §5c) | ❌ | `PROVIDER_FAILED` | `false` |
| `auth` | ❌ default; with `fallbackOnAuthOrModelNotFound: true` → ✅ (primary attempt only) | `INVALID_CONFIG` (provider) | `false` |
| `model_not_found` | ❌ default; with `fallbackOnAuthOrModelNotFound: true` → ✅ (primary attempt only) | `INVALID_CONFIG` (provider) | `false` |
| `invalid_request` (content-dependent rejection, e.g. context overflow) | ❌ | `PROVIDER_FAILED` | `false` |
| `aborted` (adapter observed the signal) | ❌ | `ABORTED` if caller signal fired, else re-classified `timeout` | `false` / `true` |
| `provider_unclassified` (non-`ProviderError` thrown by custom code) | ❌ default; with `treatUnclassifiedAsTransient: true` → classifies `transient` (fallback ✅, `retryable: true`) | `PROVIDER_FAILED` | `false` (default) |
| `output_schema_error` / `quality_error` (user code failed post-dispatch) | ❌ | user's raw exception (after settlement) | n/a |

Pre-dispatch codes: `USAGE_STORE_UNAVAILABLE` / `CONFIG_STORE_UNAVAILABLE` → `true`;
`QUOTA_EXCEEDED` → `false` (`resetsAt` carries timing); `INVALID_INPUT`,
`MISSING_SUBJECT`, `ABORTED` → `false`; `INVALID_CONFIG` → `false` except the §5a
transient-prepare case. `LLMDispatchError.retryable` is always the literal boolean from these
tables.

- Terminal code = final attempt's row; all dispatched attempts appear in
  `error.attempts`/`result.attempts`.
- Fallback: at most once, only if configured, shares the run's slot.
- Built-in adapters make exactly one client-side HTTP request per attempt: `redirect:
  'error'` on every fetch (a 3xx → `transient`; no prompt/credential ever reaches a
  redirect target); no retries in llmdispatch's own HTTP layer. (Gateway hosts may retry
  upstream internally — outside our boundary.)
- **ProviderError recognition is brand-based, never bare `instanceof`**: the class carries
  `Symbol.for('llmdispatch.ProviderError')` and exposes `ProviderError.is(value)`; the core
  classifies with `.is()` so a `ProviderError` crossing ESM/CJS entry points (dual-package
  hazard) still classifies correctly.
- Invalid usage numbers never fail a run: they normalize to `null`.
- Cancellation: adapters receive one composed signal and must honor it (§8); the core
  stops waiting and classifies from its own flags regardless. A caller's abort that wins
  while the provider call is still pending records the attempt outcome as `'aborted'`.

### 5c. Built-in adapter wire contracts (research-verified 2026-08-10; primary sources linked)

All built-ins: `fetch` with `redirect: 'error'`, JSON bodies, per-attempt signal.
**Optional request fields (`maxOutputTokens`, `temperature`) are omitted from the wire body
when unset — never defaulted** (single exception: Anthropic `max_tokens` below). Every
mapping is fixed by recorded synthetic fixtures.
**Universal status-family default (all built-ins, total by construction):** any status not
explicitly mapped classifies by family — 401/403 → `auth` (except documented moderation
envelopes → `refused`); 402/429 → `rate_limit`; 404 → `model_not_found`; 408 → `transient`;
any other 4xx (incl. 409/413/422) → `invalid_request`; any 5xx (incl. 504/529) →
`transient`; network/DNS/TLS failures → `transient`. Implementers never invent a mapping.

**`openaiCompatible({ apiKey, baseUrl?, jsonMode?, tokenParam? })` — the universal transport.**
Default `baseUrl` `https://api.openai.com/v1`; `POST {baseUrl}/chat/completions`;
`Authorization: Bearer`. ([OpenAI API reference](https://platform.openai.com/docs/api-reference/chat))
Request: `model`, `messages: [{role:'user', content: prompt}]`, `max_tokens`,
`temperature`, and `response_format: { type: 'json_object' }` only when JSON-object format
AND the JSON capability applies. **JSON capability rule:** direct known-good hosts
(api.openai.com, api.deepseek.com, api.groq.com, api.mistral.ai) get native `json_object`;
**model-multiplexing gateways (openrouter.ai, api.together.xyz, api.fireworks.ai) and
unknown hosts are prompt-only by default** — JSON-mode support there is per-MODEL, not
per-host, and an unsupported route would fail `invalid_request` without fallback; the
factory's `jsonMode: 'native' | 'prompt-only'` overrides either way and is the documented
knob when you know your models. (Ollama
`http://localhost:11434/v1`: key accepted-but-unused; schema formats silently ignored —
prompt-only. [Ollama compat](https://ollama.com/blog/openai-compatibility))
Token parameter: `max_completion_tokens` for host api.openai.com (OpenAI deprecates
`max_tokens` and rejects it on reasoning models), `max_tokens` for all other compat hosts;
factory option `tokenParam: 'max_tokens' | 'max_completion_tokens'` overrides.
Response: `choices[0].message.content`; termination normalized to `ProviderResponse.kind`:
**`message.refusal` non-empty → `'refused'` (checked even when `finish_reason` is
`stop`)**; `finish_reason` `length` → `'truncated'`; `content_filter` → `'refused'`;
`stop` → `'complete'`; other/missing → throw `ProviderError('malformed_response')`.
Usage: `usage.prompt_tokens`/`usage.completion_tokens`; **missing usage envelope or
missing/invalid base counters → `usage: null`** (never zero-defaulted).
**Embedded HTTP-200 errors (OpenRouter):** before completion parsing, a body carrying
`finish_reason: 'error'` or a top-level/choice-level `error` object classifies from its
`error.metadata.error_type`/`code` vocabulary (moderation → `refused`; auth/credit/rate →
`auth`/`rate_limit`; otherwise `transient`) — never treated as normal completion.
Errors ([OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes),
[OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging)):
401 → `auth`; **403: for OpenRouter envelopes carrying moderation metadata →
`invalid_request` (content), otherwise `auth`**; 404/model-not-found codes →
`model_not_found`; 429 and 402 → `rate_limit`; 408/5xx/498 → `transient`; other
400/413/422 → `invalid_request`; unparseable body → classify by status; unknown status →
`transient` (a real HTTP outcome, unlike unclassified thrown values).

**`anthropic({ apiKey })` — native Messages API.** `POST
https://api.anthropic.com/v1/messages`; **`x-api-key`** + required
**`anthropic-version: 2023-06-01`**. ([Anthropic Messages](https://docs.anthropic.com/en/api/messages);
the OpenAI-compat layer is not used — it ignores `response_format` and is documented as a
testing tool: [Anthropic OpenAI SDK compat](https://docs.anthropic.com/en/api/openai-sdk))
Request: `model`, `max_tokens` (**always sent** — required by Anthropic; default 4096 when
the route sets none), `messages: [{role:'user', content: prompt}]`, `temperature` (0–1;
core-range values are clamped, documented). JSON is prompt-driven in v0.1.
Response: first `text` block of `content[]`; `stop_reason` normalized to
`ProviderResponse.kind`: `max_tokens` **and `model_context_window_exceeded`** →
`'truncated'`; `refusal` → `'refused'`; `end_turn`/`stop_sequence` → `'complete'`; other →
throw `ProviderError('malformed_response')`. Usage: base counters `input_tokens` and
`output_tokens` are REQUIRED — missing/invalid → `usage: null`; the additive optional
cache categories (`cache_creation_input_tokens`, `cache_read_input_tokens`) default 0 and
are summed into `inputTokens`. ([Anthropic usage/caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching),
[stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons))
Errors (envelope `{type:'error', error:{type,message}}`): `authentication_error` →
`auth`; `not_found_error` → `model_not_found`; `rate_limit_error`/429 → `rate_limit`;
`overloaded_error`/529/5xx → `transient`; `invalid_request_error`/400 → `invalid_request`.

**`gemini({ apiKey })` — native generateContent.** `POST
https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`;
`x-goog-api-key` header. Pinned to `v1beta` deliberately: it is the channel Google's
Gemini API docs default to and where JSON-output fields live; verified by recorded
fixtures and the release live-check gate ([Gemini API](https://ai.google.dev/api/generate-content),
[API versions](https://ai.google.dev/gemini-api/docs/api-versions)). The OpenAI-compat
endpoint is not used: it is officially beta, and only the native API documents explicit
thought-token accounting (`thoughtsTokenCount`) and full termination metadata — both of
which this design depends on ([Gemini OpenAI compat](https://ai.google.dev/gemini-api/docs/openai),
[native usage fields](https://ai.google.dev/api/generate-content); the compat-usage
discrepancy observed in the research is recorded as an empirical fixture-verification item,
not the primary rationale).
Request: `contents: [{role:'user', parts:[{text: prompt}]}]`, `generationConfig:
{ maxOutputTokens?, temperature?, responseMimeType: 'application/json' }` (MIME only for
JSON-object format; prompt still carries the shape).
Response: `candidates[0].content.parts[]` text concatenated; termination normalized to
`ProviderResponse.kind`: `promptFeedback.blockReason` present → `'refused'`; no candidates
WITHOUT block metadata → throw `ProviderError('malformed_response')`; `finishReason`
`MAX_TOKENS` → `'truncated'`; any policy/filter reason (`SAFETY`, `RECITATION`,
`PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `ESCALATION`, `LANGUAGE`) → `'refused'`; `STOP` →
`'complete'`; other → throw `ProviderError('malformed_response')`. Usage: base counter
`promptTokenCount` REQUIRED (missing/invalid → `usage: null`); `outputTokens =
candidatesTokenCount + thoughtsTokenCount` where `candidatesTokenCount` is required and
`thoughtsTokenCount` is additive-optional (default 0; thinking tokens are billed output —
[thinking docs](https://ai.google.dev/gemini-api/docs/thinking)).
Errors (`{error:{code,status,message}}`): 401/403 → `auth`; 404 → `model_not_found`;
429/`RESOURCE_EXHAUSTED` → `rate_limit`; 500/503 → `transient`; 400/`INVALID_ARGUMENT` →
`invalid_request`.

## 6. Public API (authoritative, self-contained, compiles under strict TS + Zod 4)

```ts
import { z } from 'zod'

// ——— entry point ———
export declare function createSwitch<Ops extends OperationsMap>(
  config: CreateSwitchConfig<Ops>
): Switch<Ops>

// Inference builders. defineOperation correlates each operation's schemas with its
// callbacks; **every entry in defineOperations MUST be wrapped in defineOperation** —
// defineOperations is an identity collector and does not itself restore inference.
// The README quickstart uses exactly this shape; negative compile fixtures assert that
// invalid `prompt` input and `quality.data` accesses FAIL to compile in that shape.
export declare function defineOperation<In extends z.ZodType, Out extends z.ZodType>(
  def: OperationDefinition<In, Out>
): OperationDefinition<In, Out>
export declare function defineOperations<Ops extends OperationsMap>(ops: Ops): Ops
export type OperationsMap = Record<string, OperationDefinition<z.ZodType, z.ZodType>>

export interface Switch<Ops extends OperationsMap> {
  run<K extends keyof Ops & string>(
    operation: K,
    args: { input: z.input<Ops[K]['input']>; subjectId?: string },
    options?: { signal?: AbortSignal }
  ): Promise<RunResult<z.output<Ops[K]['output']>>>
  getConfig(): Promise<Record<keyof Ops & string, OperationConfigView>>
  setConfig(operation: keyof Ops & string, route: OperationRoute): Promise<void>
  resetConfig(operation: keyof Ops & string): Promise<void>
  getQuota(operation: keyof Ops & string, subjectId: string): Promise<QuotaView> // resolves config first (§2), so it may also fail CONFIG_STORE_UNAVAILABLE/INVALID_CONFIG; no effective quota → INVALID_INPUT
}

export interface CreateSwitchConfig<Ops extends OperationsMap> {
  providers: Record<string, Provider>
  operations: Ops
  stores: StorePair
  pricing?: Record<string, Record<string, ModelPrice>>
  configTtlMs?: number                                   // default 5_000; 0–300_000
  treatUnclassifiedAsTransient?: boolean                 // default false
  fallbackOnAuthOrModelNotFound?: boolean                // default false; primary attempt only (§5a/§5b)
  onSettlementError?: (error: unknown, record: SettlementFailure) => void | Promise<void>
  logger?: Logger
}
export interface SettlementFailure {
  reservation: ReservationEnvelope
  outcome: 'succeeded' | 'failed'
  attempts: AttemptRecord[]
}
export interface StorePair { config: ConfigStore; usage: UsageStore }
export interface Logger {                                // invoked through caught promise chains
  info(message: string, data?: unknown): void | Promise<void>
  warn(message: string, data?: unknown): void | Promise<void>
  error(message: string, data?: unknown): void | Promise<void>
}

// ——— operations ———
export interface OperationDefinition<In extends z.ZodType, Out extends z.ZodType> {
  input: In
  output: Out
  prompt: (input: z.output<In>) => string | Promise<string>
  format?: 'json' | 'json-any' | 'text'                  // default 'json' (§3)
  quality?: (ctx: { input: z.output<In>; data: z.output<Out> }) => QualityVerdict | Promise<QualityVerdict>
  quota?: { perDay: number }                             // safe integer, 0–1_000_000 (0 = halted)
  timeoutMs?: number                                     // provider I/O timeout; default 60_000; 1_000–600_000
  defaultRoute?: OperationRoute
}
export type QualityVerdict = { ok: true } | { ok: false; reason?: string }

// ——— routing / views ———
export interface OperationRoute {
  provider: string                                       // non-empty registered provider ID
  model: string                                          // non-empty
  maxOutputTokens?: number                               // safe integer ≥ 1
  temperature?: number                                   // finite, 0–2 (profiles may clamp; §5c)
  quota?: { perDay: number }                             // safe integer, 0–1_000_000; overrides the declared quota (§2)
  fallback?: RouteTarget | null
}
export interface RouteTarget {
  provider: string; model: string; maxOutputTokens?: number; temperature?: number
}
export interface OperationConfigView {
  stored: OperationRoute | null | 'malformed'
  effective: OperationRoute | null
}
export interface QuotaView { limit: number; used: number; remaining: number; resetsAt: string } // limit = the effective limit (route override, else declared); remaining = max(0, limit - used); getQuota requires non-empty subjectId

// ——— run results ———
export interface RunResult<Out> {
  data: Out
  route: { provider: string; model: string }
  usedFallback: boolean
  attempts: AttemptRecord[]
  usage: TokenUsage
  usageComplete: boolean
  cost: number | null
}
export type AttemptOutcome = 'succeeded' | 'timeout' | 'truncated' | 'refused'
  | 'output_rejected' | 'output_schema_error' | 'quality_error' | 'provider_unclassified'
  | ProviderErrorKind
export interface AttemptRecord {
  provider: string
  model: string
  outcome: AttemptOutcome
  status?: number
  usage: TokenUsage | null
  costUsd: number | null
  // Provider I/O only: from dispatch to settlement of the provider call on the
  // injected clock. Output processing is not counted.
  durationMs: number
}
export interface TokenUsage { inputTokens: number; outputTokens: number }  // non-negative SAFE integers
export interface ModelPrice { inputPerM: number; outputPerM: number }      // finite, ≥ 0

// ——— providers ———
export interface Provider {
  prepare?(): PreparedProvider | Promise<PreparedProvider>  // §5a; memoized per run per provider ID
  complete(req: ProviderRequest): Promise<ProviderResponse> // used directly when prepare absent
}
export interface PreparedProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>
}
export interface ProviderRequest {
  prompt: string
  model: string
  responseFormat: { type: 'text' } | { type: 'json'; topLevel: 'object' | 'any' }
  maxOutputTokens?: number
  temperature?: number
  signal: AbortSignal
}
// Discriminated: truncation and refusal are billable HTTP-200 terminations, so they travel
// on the RESPONSE (usage retained), not as thrown errors. `kind: 'complete'` proceeds to
// the output pipeline; 'truncated' classifies `truncated`; 'refused' classifies `refused`.
// `text` may be partial or empty for the non-complete kinds.
export type ProviderResponse =
  | { kind: 'complete';  text: string; usage: TokenUsage | null }
  | { kind: 'truncated'; text: string; usage: TokenUsage | null }  // text may be partial
  | { kind: 'refused';   text: string; usage: TokenUsage | null }  // text may be empty
export type ProviderErrorKind = 'transient' | 'rate_limit' | 'auth' | 'model_not_found'
  | 'invalid_request' | 'aborted' | 'malformed_response'
export declare class ProviderError extends Error {
  constructor(kind: ProviderErrorKind, opts?: { status?: number; message?: string })
  readonly kind: ProviderErrorKind
  readonly status?: number
  // Brand-based recognition (dual-package safe). The core NEVER uses bare instanceof.
  static is(value: unknown): value is ProviderError
}

// built-in factories (fetch-based, zero dependencies; implement prepare(); wire contracts §5c)
export declare function anthropic(opts: { apiKey: ApiKeyResolver }): Provider
export declare function openaiCompatible(opts: {
  apiKey: ApiKeyResolver
  baseUrl?: string
  jsonMode?: 'native' | 'prompt-only'                    // overrides the §5c host capability rule
  tokenParam?: 'max_tokens' | 'max_completion_tokens'    // overrides the §5c host token-param rule
}): Provider
export declare function gemini(opts: { apiKey: ApiKeyResolver }): Provider
export type ApiKeyResolver = () => string | undefined | Promise<string | undefined>

// ——— stores ———
export interface ConfigStore {
  getAll(): Promise<Record<string, unknown>>
  set(operation: string, route: OperationRoute): Promise<void>
  delete(operation: string): Promise<void>
}
export type QuotaKey = { operation: string; subjectId: string }
export interface ReservationEnvelope { reservationId: string; key: QuotaKey; day: string } // day: 'YYYY-MM-DD' UTC, store-chosen
export interface UsageStore {
  reserve(key: QuotaKey, limit: number): Promise<
    | { ok: true; reservation: ReservationEnvelope; expiresAt: string }
    | { ok: false; used: number; resetsAt: string }
  >
  commit(reservationId: string): Promise<'committed' | 'expired' | 'missing'>
  settle(reservation: ReservationEnvelope, outcome: 'succeeded' | 'failed', attempts: AttemptRecord[]): Promise<void>
  snapshot(key: QuotaKey): Promise<{ used: number; resetsAt: string }>
}
export declare function memoryStores(): StorePair
export declare function postgresStores(opts: {
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }
  schema?: string                                        // default 'llmdispatch'; validated identifier
  leaseMs?: number                                       // default 120_000; 5_000–600_000
}): StorePair

// ——— errors ———
export declare class LLMDispatchError extends Error {
  private constructor()                                  // instances come from the package; narrow on `code`
  readonly code: 'INVALID_INPUT' | 'MISSING_SUBJECT' | 'QUOTA_EXCEEDED'
    | 'USAGE_STORE_UNAVAILABLE' | 'CONFIG_STORE_UNAVAILABLE' | 'INVALID_CONFIG'
    | 'ABORTED' | 'PROVIDER_FAILED' | 'OUTPUT_REJECTED'
  readonly operation?: string
  readonly retryable: boolean                            // literal per §5a/§5b
  readonly resetsAt?: string
  readonly detectedAt?: 'local' | 'provider'
  readonly attempts?: AttemptRecord[]
  // Sanitized, scoped to the package's own fields: they never carry prompts, model
  // output, or raw provider errors from a dispatched attempt. A pre-dispatch error may
  // chain the underlying store or `prepare()` failure as `cause`, verbatim — the
  // adopter's own thrown error, or a provider adapter's readiness failure.
}
```

Runtime validation: all ranges enforced at `createSwitch`/`setConfig` with a thrown error
naming the field; all counts are non-negative **safe** integers (`Number.isSafeInteger`);
pricing finite ≥ 0; provider responses failing the `ProviderResponse` union shape
(unknown `kind`, non-string `text`) → `malformed_response`; invalid usage → `null`;
non-string prompt returns → unwrapped
`TypeError` (pre-quota); malformed quality verdicts → `quality_error`; malformed prepared
dispatchers → `INVALID_CONFIG` (local).

**String domain.** Every string that reaches a store — operation names, provider
registration IDs, `OperationRoute`/`RouteTarget` `provider` and `model`, `subjectId`,
`ReservationEnvelope.reservationId`, and `AttemptRecord.provider`/`model` — is well-formed
Unicode (`String.prototype.isWellFormed()`), contains no U+0000, and is at most 1 000 bytes
of UTF-8. The core checks this **before any store call**, at these boundaries: operation
names, provider IDs and declared routes at `createSwitch` → `INVALID_CONFIG`; a route at
`setConfig` → `INVALID_CONFIG`; `subjectId` before `reserve` and before `getQuota`'s
`snapshot` → `INVALID_INPUT`. A stored `ConfigStore` row that violates it is a malformed row
and follows the §2 rules. A `ReservationEnvelope` returned by `reserve` that violates it is a
malformed store result → `USAGE_STORE_UNAVAILABLE`, checked before `commit`; the envelope and
the attempt records are checked again before `settle`. A store additionally rejects
out-of-domain values as defence in depth. The bound is part of the contract because a
relational store cannot hold every JavaScript string: PostgreSQL `text` and `jsonb` reject
U+0000, lone surrogates do not survive a round trip, and index entries are size-capped — so a
store that had to narrow the domain itself would not be substitutable.

## 6a. Core-enforced store deadlines

`ConfigStore.getAll` 5s; `set`/`delete` 10s (unknown-ack semantics per §2);
`reserve`/`commit`/`snapshot` 10s; `settle` 10s per attempt including each detached retry.
`getQuota` may spend both in sequence — a `getAll` that is not served from cache, then
`snapshot` — so its worst case is 15s. Constants in v0.1.

## 6b. Packaged operational surfaces (exact declarations)

```ts
// subpath: llmdispatch/postgres
export declare const MIGRATIONS: ReadonlyArray<{
  version: number
  templateSha256: string                                  // hash of the canonical template (schema placeholder form)
  render(opts?: { schema?: string }): { sql: string; sha256: string }  // hash of the exact rendered bytes
}>
// All versions concatenated in order, idempotent, schema-rendered; sha256 covers the
// exact aggregate sql bytes.
export declare function migrationSql(opts?: { schema?: string }): { sql: string; sha256: string }
// The comment every usage-protocol statement begins with. A harness that reaches the packaged
// store only through an adopter-shaped pool recognises marked statements by it and substitutes
// their trailing clock parameter (see the conformance note below).
export declare const USAGE_STORE_MARKER: string

// subpath: llmdispatch/conformance
export interface ConformanceResult { passed: boolean; failures: string[]; skipped: string[] }
export declare function runUsageStoreConformance(opts: {
  // create returns the store under test plus REQUIRED test controls:
  // setTime drives the STORE's authoritative clock and is called with non-decreasing
  // instants between reset() calls. For the packaged PostgreSQL store the supported
  // convention is statement-level: every usage-protocol statement begins with the
  // exported USAGE_STORE_MARKER comment and carries the clock override as its TRAILING
  // parameter (null = the database's own clock), so a harness that reaches the store only
  // through an adopter-shaped pool recognises marked statements and substitutes that
  // final parameter. reset wipes state; readSettled exposes what settle() persisted so
  // duplicate/conflict/unknown-reservation behavior is observable.
  create(): Promise<{
    store: UsageStore
    setTime(date: Date): Promise<void>
    reset(): Promise<void>
    readSettled(reservationId: string): Promise<{ reservation: ReservationEnvelope; outcome: string; attempts: AttemptRecord[] } | null>
  }>
}): Promise<ConformanceResult>
export declare function runConfigStoreConformance(opts: {
  // seedRaw writes an arbitrary raw value for an operation, enabling malformed-row cases.
  create(): Promise<{ store: ConfigStore; reset(): Promise<void>; seedRaw(operation: string, value: unknown): Promise<void> }>
}): Promise<ConformanceResult>
export declare function runProviderConformance(opts: {
  provider: Provider
  // Produces a dispatchable request for the provider's backend (model, prompt).
  requestFactory: () => ProviderRequest
  // 'success' is MANDATORY; each other scenario puts the adopter's backend into the named
  // condition and resolves when ready; the harness dispatches and asserts the resulting
  // ProviderResponse.kind or ProviderError classification. Absent optional scenarios are
  // reported in `skipped` — a skipped scenario means that classification is UNVERIFIED.
  scenarios: { success: () => Promise<void> } & Partial<Record<
    'auth' | 'rate_limit' | 'model_not_found' | 'invalid_request' | 'transient'
    | 'malformed_response' | 'truncated' | 'refused', () => Promise<void>>>
  // Optional controls: declare JSON capability and observe dispatched requests so the
  // harness can verify responseFormat without guessing the provider's wire behaviour.
  controls?: {
    jsonCapability?: 'native' | 'prompt-only'
    observeRequest?: (req: ProviderRequest) => void
  }
}): Promise<ConformanceResult>  // passed === (failures.length === 0); skipped is informational
```

Both subpaths appear in the manifest `exports` with per-condition `.d.ts`/`.d.cts`
declarations and ship in `files`. The packaged migration path and per-version `sha256`
make release verification concrete: before every publish, the packaged SQL is applied to a
real PostgreSQL and all three harnesses run from the installed tarball; a release ships
only on pass.

## 7. Cost and usage model (scope-limited by design)

Normalization formulas are fixed per adapter in §5c. The universal rule: **required base
counters missing or invalid → the attempt's usage is `null`** (never a fabricated zero);
only explicitly additive-optional categories (Anthropic cache fields, Gemini thought
tokens) default to 0. Raw provider usage is not exposed. **Aggregates (normative):**
`result.usage` = field-wise sum over attempts with non-null usage (`{0,0}` when none);
`usageComplete` = true iff every dispatched attempt has non-null usage AND neither
aggregate field overflowed (field-wise clamp to `Number.MAX_SAFE_INTEGER` on overflow).
`cost` = `inputTokens × inputPerM/1e6 + outputTokens × outputPerM/1e6` per attempt, priced
by registered provider ID + model. Every dispatched attempt is potentially billable: if
any dispatched attempt lacks usage or a price, aggregate `cost` is `null`. Cached-token
discounts, tiered pricing, and request fees are out of scope in v0.1.

## 8. Conformance suite (adopter-facing)

Runners per §6b. Three of the cases below are new to this contract — two `UsageStore` cases
(a `reserve` at limit 0, and a limit lowered below existing usage) and one `ConfigStore` case
(a route carrying `quota`) — so a custom store can fail the suite without any change on its
side: a `UsageStore` that treats a non-positive `limit` as unlimited, or a `ConfigStore` that
persists only a whitelist of route fields, needs updating. Coverage:

- **UsageStore:** reserve atomicity under concurrency (globally-unique reservation IDs;
  oversubscription: callers > limit), commit/settle idempotency, lost-ack commit retry,
  lease expiry (pending frees, committed never), lease capped at day boundary, day
  rollover via `setTime`, snapshot correctness including pending, settle
  duplicate/conflict/unknown-reservation behavior observed via `readSettled`,
  envelope validity (key match, `YYYY-MM-DD` day format), a `reserve` call with `limit: 0`
  denying without inserting a reservation (observed as: a following `reserve` at `limit: 1`
  on the same key is admitted with `used` 0), and a limit lowered below existing
  pending/committed usage denying new reservations while leaving those rows intact.
  (Settle-FAILURE isolation — a rejecting store not affecting run outcomes — is core
  behavior, tested internally.)
- **ConfigStore:** set/get/delete round-trip fidelity, raw-value persistence via
  `seedRaw` (the store must return exactly what was written — validation is the CORE's
  job and is tested internally), delete-removes-row, read-your-writes, and a route carrying
  `quota` returned verbatim like any other field.
- **Provider:** mandatory success dispatch (correct `kind`/text/usage shape); honors
  `signal`; classifies each supplied scenario via `ProviderResponse.kind` or
  `ProviderError`; respects `responseFormat` per its capability; normalizes usage or
  returns `null`. Skipped optional scenarios are reported as unverified. Core-behavior
  checks are internal package tests, not part of this suite: state machine, matrices,
  sanitization, validation-on-read, default-restoration, effective-quota precedence
  (including a stored row without `quota`), a stored `quota` enabling subject enforcement and
  its precedence after stage 4, `getQuota` under a fresh cache and under a config outage with
  its full precedence order, `quota.perDay` range validation including 0, and
  `fallbackOnAuthOrModelNotFound` (eligibility on the primary attempt only, terminal code per
  §5b, and the `detectedAt` rule).
