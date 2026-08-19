/**
 * The public type surface, transcribed from `docs/spec.md` §6 in the order it declares them.
 *
 * Shapes only: the file imports nothing but Zod, so every other folder can depend on it
 * without inheriting anything, and a public shape is never declared twice. Ranges and
 * defaults stay in the comments the spec gives them — they are enforced at runtime, since a
 * `number` cannot say "safe integer, 0 to 1 000 000".
 *
 * @module
 */

import type { z } from 'zod'

// ——— entry point ———

/** The operations a switch is built from; every entry MUST be wrapped in `defineOperation`. */
export type OperationsMap = Record<string, OperationDefinition<z.ZodType, z.ZodType>>

/** A configured switch: one `run` method plus the admin surface for its runtime config. */
export interface Switch<Ops extends OperationsMap> {
  /**
   * Runs one operation end to end and resolves with its validated result.
   *
   * @throws `LLMSwitchError` with the code the final classification maps to (spec §5b).
   */
  run<K extends keyof Ops & string>(
    operation: K,
    args: { input: z.input<Ops[K]['input']>; subjectId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<RunResult<z.output<Ops[K]['output']>>>
  getConfig(): Promise<Record<keyof Ops & string, OperationConfigView>>
  setConfig(operation: keyof Ops & string, route: OperationRoute): Promise<void>
  resetConfig(operation: keyof Ops & string): Promise<void>
  // Resolves config first (§2), so it may also fail CONFIG_STORE_UNAVAILABLE/INVALID_CONFIG;
  // no effective quota → INVALID_INPUT; requires non-empty subjectId
  getQuota(operation: keyof Ops & string, subjectId: string): Promise<QuotaView>
}

/** Everything `createSwitch` needs: who can be called, what the app does, where state lives. */
export interface CreateSwitchConfig<Ops extends OperationsMap> {
  providers: Record<string, Provider>
  operations: Ops
  stores: StorePair
  pricing?: Record<string, Record<string, ModelPrice>>
  configTtlMs?: number // default 5_000; 0–300_000
  treatUnclassifiedAsTransient?: boolean // default false
  fallbackOnAuthOrModelNotFound?: boolean // default false; primary attempt only (§5a/§5b)
  onSettlementError?: (error: unknown, record: SettlementFailure) => void | Promise<void>
  logger?: Logger
}

/** What `onSettlementError` is handed: the accounting that could not be written. */
export interface SettlementFailure {
  reservation: ReservationEnvelope
  outcome: 'succeeded' | 'failed'
  attempts: AttemptRecord[]
}

/** The two stores a switch runs on, handed over together. */
export interface StorePair {
  config: ConfigStore
  usage: UsageStore
}

/** A sink for the package's diagnostics; invoked through caught promise chains. */
export interface Logger {
  info(message: string, data?: unknown): void | Promise<void>
  warn(message: string, data?: unknown): void | Promise<void>
  error(message: string, data?: unknown): void | Promise<void>
}

// ——— operations ———

/** One operation: its schemas, its prompt, and the optional gates around them. */
export interface OperationDefinition<In extends z.ZodType, Out extends z.ZodType> {
  input: In
  output: Out
  prompt: (input: z.output<In>) => string | Promise<string>
  format?: 'json' | 'json-any' | 'text' // default 'json' (§3)
  quality?: (ctx: {
    input: z.output<In>
    data: z.output<Out>
  }) => QualityVerdict | Promise<QualityVerdict>
  quota?: { perDay: number } // safe integer, 0–1_000_000 (0 = halted)
  timeoutMs?: number // provider I/O timeout; default 60_000; 1_000–600_000
  defaultRoute?: OperationRoute
}

/** What a `quality` gate answers: accepted, or rejected with an optional reason. */
export type QualityVerdict = { ok: true } | { ok: false; reason?: string }

// ——— routing / views ———

/** One operation's stored route: who answers, with what, under which limit. */
export interface OperationRoute {
  provider: string // non-empty registered provider ID
  model: string // non-empty
  maxOutputTokens?: number // safe integer ≥ 1
  temperature?: number // finite, 0–2 (profiles may clamp; §5c)
  quota?: { perDay: number } // safe integer, 0–1_000_000; overrides the declared quota (§2)
  fallback?: RouteTarget | null
}

/** Where a fallback attempt goes: a route without a quota or a fallback of its own. */
export interface RouteTarget {
  provider: string
  model: string
  maxOutputTokens?: number
  temperature?: number
}

/** What `getConfig` reports per operation: what is stored, and what that resolves to. */
export interface OperationConfigView {
  stored: OperationRoute | null | 'malformed'
  effective: OperationRoute | null
}

/** One subject's standing against one operation's daily limit. */
export interface QuotaView {
  limit: number // the effective limit: route override, else declared
  used: number
  remaining: number // max(0, limit - used)
  resetsAt: string
}

// ——— run results ———

/** What a successful `run` resolves with. */
export interface RunResult<Out> {
  data: Out
  route: { provider: string; model: string }
  usedFallback: boolean
  attempts: AttemptRecord[]
  usage: TokenUsage
  usageComplete: boolean
  cost: number | null
}

/** How one dispatched attempt ended, per the §5b classification table. */
export type AttemptOutcome =
  | 'succeeded'
  | 'timeout'
  | 'truncated'
  | 'refused'
  | 'output_rejected'
  | 'output_schema_error'
  | 'quality_error'
  | 'provider_unclassified'
  | ProviderErrorKind

/** One dispatched attempt, as it is reported and as it is persisted. */
export interface AttemptRecord {
  provider: string
  model: string
  outcome: AttemptOutcome
  status?: number
  usage: TokenUsage | null
  costUsd: number | null
  durationMs: number
}

/** Provider-reported token counts. Non-negative SAFE integers. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** One model's price, per million tokens. Finite, ≥ 0. */
export interface ModelPrice {
  inputPerM: number
  outputPerM: number
}

// ——— providers ———

/** What a provider adapter implements: one call out, optionally with a readiness step. */
export interface Provider {
  prepare?(): PreparedProvider | Promise<PreparedProvider> // §5a; memoized per run per provider ID
  complete(req: ProviderRequest): Promise<ProviderResponse> // used directly when prepare absent
}

/** What `prepare()` hands back: a dispatcher scoped to one run. */
export interface PreparedProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>
}

/** One attempt, as the adapter receives it. */
export interface ProviderRequest {
  prompt: string
  model: string
  responseFormat: { type: 'text' } | { type: 'json'; topLevel: 'object' | 'any' }
  maxOutputTokens?: number // omitted from the wire body when unset — never defaulted (§5c)
  temperature?: number // omitted from the wire body when unset — never defaulted (§5c)
  signal: AbortSignal
}

/**
 * What an attempt returned, discriminated by how the provider terminated.
 *
 * Truncation and refusal are billable HTTP-200 terminations, so they travel on the RESPONSE
 * (usage retained), not as thrown errors. `kind: 'complete'` proceeds to the output pipeline;
 * `'truncated'` classifies `truncated`; `'refused'` classifies `refused`.
 */
export type ProviderResponse =
  | { kind: 'complete'; text: string; usage: TokenUsage | null }
  | { kind: 'truncated'; text: string; usage: TokenUsage | null } // text may be partial
  | { kind: 'refused'; text: string; usage: TokenUsage | null } // text may be empty

/** How an adapter classifies a failure; the classification drives fallback (§5b). */
export type ProviderErrorKind =
  | 'transient'
  | 'rate_limit'
  | 'auth'
  | 'model_not_found'
  | 'invalid_request'
  | 'aborted'
  | 'malformed_response'

/** How a built-in adapter reaches its API key, resolved lazily on every run. */
export type ApiKeyResolver = () => string | undefined | Promise<string | undefined>

// ——— stores ———

/** Where routes live. Rows come back verbatim; validating them is the core's job. */
export interface ConfigStore {
  getAll(): Promise<Record<string, unknown>>
  set(operation: string, route: OperationRoute): Promise<void>
  delete(operation: string): Promise<void>
}

/** What a daily allowance is counted against: one operation, one subject. */
// An alias rather than an interface because that is how spec §6 declares it, and the
// published declaration is the one adopters read against the spec.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type QuotaKey = { operation: string; subjectId: string }

/** The store-created handle for one reserved slot. `day`: 'YYYY-MM-DD' UTC, store-chosen. */
export interface ReservationEnvelope {
  reservationId: string
  key: QuotaKey
  day: string
}

/** Where quota slots are counted. The store's clock owns the UTC day (§4). */
export interface UsageStore {
  reserve(
    key: QuotaKey,
    limit: number,
  ): Promise<
    | { ok: true; reservation: ReservationEnvelope; expiresAt: string }
    | { ok: false; used: number; resetsAt: string }
  >
  commit(reservationId: string): Promise<'committed' | 'expired' | 'missing'>
  settle(
    reservation: ReservationEnvelope,
    outcome: 'succeeded' | 'failed',
    attempts: AttemptRecord[],
  ): Promise<void>
  snapshot(key: QuotaKey): Promise<{ used: number; resetsAt: string }>
}

// ——— packaged operational surfaces (spec §6b) ———
//
// The shapes `llmswitch/postgres` and `llmswitch/conformance` publish are declared below this
// line and re-exported by those entry points alone, so the root surface stays exactly §6.

/** What a conformance run reports. `passed` is true exactly when `failures` is empty. */
export interface ConformanceResult {
  passed: boolean
  failures: string[]
  skipped: string[]
}
