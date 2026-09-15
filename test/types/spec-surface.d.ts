// Generated from the code fences of docs/spec.md by scripts/check-spec-surface.mjs.
// Edit the spec, then run `npm run surface:update`.

import { z } from 'zod'

// --- entry point ---
export declare function createSwitch<Ops extends OperationsMap>(
  config: CreateSwitchConfig<Ops>
): Switch<Ops>

// Inference builders. defineOperation correlates each operation's schemas with its
// callbacks; **every entry in defineOperations MUST be wrapped in defineOperation**;
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

// --- operations ---
// What a request is made of. A prompt callback returning a string normalizes to one
// TextPart; the parts a callback returns are copied, frozen, and validated before stage 7.
export interface TextPart {
  readonly type: 'text'
  readonly text: string                                  // any string, '' included
}
export interface FilePart {
  readonly type: 'file'
  readonly mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  readonly data: string                                  // base64, standard alphabet, no data-URL prefix
  readonly filename?: string                             // <= 128 chars, no control characters, no path separator
}
export type ContentPart = TextPart | FilePart

// --- image output ---
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
export type ImageSize = '1K' | '2K' | '4K'                // provider-relative resolution class, not a pixel promise
export interface ImageOptions {
  readonly count?: number                                // safe integer, 1–10; omitted = provider default (one)
  readonly aspectRatio?: AspectRatio
  readonly size?: ImageSize
  readonly background?: 'transparent' | 'opaque'
}
export type GeneratedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'
// As an adapter hands an image back: dimensions both stated, or both left to the core's header read.
export type ProviderImage = { readonly mediaType: GeneratedImageMediaType; readonly data: string }
  & ({ readonly width: number; readonly height: number } | { readonly width?: undefined; readonly height?: undefined })
// As an adopter receives it: a FilePart that also states the encoded raster's pixel size.
export interface GeneratedImage {
  readonly type: 'file'
  readonly mediaType: GeneratedImageMediaType
  readonly data: string
  readonly width: number
  readonly height: number
}
export interface ImageOutput { readonly images: readonly GeneratedImage[]; readonly text: string }
// A z.ZodType<ImageOutput> accepting at least one well-formed image; refine it for more.
export declare const imageOutputSchema: z.ZodType<ImageOutput>

export interface OperationDefinition<In extends z.ZodType, Out extends z.ZodType> {
  input: In
  output: Out
  prompt: (input: z.output<In>) => string | readonly ContentPart[] | Promise<string | readonly ContentPart[]>
  format?: 'json' | 'json-any' | 'text' | 'image'        // default 'json' (§3)
  image?: ImageOptions                                   // only with format 'image'; validated at createSwitch
  quality?: (ctx: { input: z.output<In>; data: z.output<Out> }) => QualityVerdict | Promise<QualityVerdict>
  quota?: { perDay: number }                             // safe integer, 0–1_000_000 (0 = halted)
  timeoutMs?: number                                     // provider I/O timeout; default 60_000; 1_000–600_000
  defaultRoute?: OperationRoute
}
export type QualityVerdict = { ok: true } | { ok: false; reason?: string }

// --- routing / views ---
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

// --- run results ---
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
export interface TokenUsage { inputTokens: number; outputTokens: number; imageOutputTokens?: number }  // non-negative SAFE integers; imageOutputTokens ≤ outputTokens (§7)
export interface ModelPrice { inputPerM: number; outputPerM: number; imageOutputPerM?: number }        // finite, ≥ 0

// --- providers ---
export interface Provider {
  prepare?(): PreparedProvider | Promise<PreparedProvider>  // §5a; memoized per run per provider ID
  complete(req: ProviderRequest): Promise<ProviderResponse> // used directly when prepare absent
}
export interface PreparedProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>
}
export interface ProviderRequest {
  parts: readonly ContentPart[]                          // normalized, non-empty, frozen
  model: string
  responseFormat: { type: 'text' } | { type: 'json'; topLevel: 'object' | 'any' } | ({ type: 'image' } & ImageOptions)
  maxOutputTokens?: number
  temperature?: number
  signal: AbortSignal
}
// Discriminated: truncation and refusal are billable terminations the adapter normalizes
// from a success or an error response (§5c), so they travel on the RESPONSE (usage
// retained), not as thrown errors. `kind: 'complete'` proceeds to the output pipeline;
// 'truncated' classifies `truncated`; 'refused' classifies `refused`. `text` may be partial
// or empty for the non-complete kinds. `images` is read only for an image-format operation
// (§3). `costUsd` is the provider's own charge and, when finite and non-negative, is
// authoritative over the pricing table (§7).
export type ProviderResponse =
  | { kind: 'complete';  text: string; usage: TokenUsage | null; images?: readonly ProviderImage[]; costUsd?: number }
  | { kind: 'truncated'; text: string; usage: TokenUsage | null; costUsd?: number }  // text may be partial
  | { kind: 'refused';   text: string; usage: TokenUsage | null; costUsd?: number }  // text may be empty
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
export declare function anthropic(opts: { apiKey: ApiKeyResolver; baseUrl?: string }): Provider
export declare function openaiCompatible(opts: {
  apiKey: ApiKeyResolver
  baseUrl?: string
  jsonMode?: 'native' | 'prompt-only'                    // overrides the §5c host capability rule
  tokenParam?: 'max_tokens' | 'max_completion_tokens'    // overrides the §5c host token-param rule
}): Provider
export declare function gemini(opts: { apiKey: ApiKeyResolver }): Provider
export type ApiKeyResolver = () => string | undefined | Promise<string | undefined>

// --- stores ---
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

// --- errors ---
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
  // chain the underlying store or `prepare()` failure as `cause`, verbatim: the
  // adopter's own thrown error, or a provider adapter's readiness failure.
}
