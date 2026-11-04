import { A as QuotaKey, B as TextPart, C as Provider, D as ProviderResponse, E as ProviderRequest, F as SettlementFailure, H as UsageStore, I as StorePair, L as SvgOptions, M as ReservationEnvelope, N as RouteTarget, O as ProviderSvg, P as RunResult, R as SvgOutput, S as PreparedProvider, T as ProviderImage, V as TokenUsage, _ as ModelPrice, a as ConfigStore, b as OperationRoute, c as CreateSwitchConfig, d as GeneratedImageMediaType, f as GeneratedSvg, g as Logger, h as ImageSize, i as AttemptRecord, j as QuotaView, k as QualityVerdict, l as FilePart, m as ImageOutput, n as AspectRatio, p as ImageOptions, r as AttemptOutcome, s as ContentPart, t as ApiKeyResolver, u as GeneratedImage, v as OperationConfigView, w as ProviderErrorKind, x as OperationsMap, y as OperationDefinition, z as Switch } from "./types.js";
import { z } from "zod";
/** A classified failure: a stable `code`, a literal `retryable`, no dispatch content of its own. */
export declare class LLMDispatchError extends Error {
  private constructor();
  /** What went wrong, as a closed set (spec §5b). */
  readonly code: 'INVALID_INPUT' | 'MISSING_SUBJECT' | 'QUOTA_EXCEEDED' | 'USAGE_STORE_UNAVAILABLE' | 'CONFIG_STORE_UNAVAILABLE' | 'INVALID_CONFIG' | 'ABORTED' | 'PROVIDER_FAILED' | 'OUTPUT_REJECTED';
  /** The operation that failed. */
  readonly operation?: string;
  /** Literal per §5a/§5b. */
  readonly retryable: boolean;
  /** When the daily allowance resets, as an ISO instant. `QUOTA_EXCEEDED` carries it. */
  readonly resetsAt?: string;
  /** Whether an `INVALID_CONFIG` was found locally or reported by the provider. */
  readonly detectedAt?: 'local' | 'provider';
  /** Every dispatched attempt, in dispatch order. */
  readonly attempts?: AttemptRecord[];
}
/** A provider failure, classified by the adapter that saw it (spec §5b). */
export declare class ProviderError extends Error {
  /**
   * Classifies a failed provider call.
   *
   * @param kind The §5b row that describes what happened; it decides whether the run falls back.
   * @param opts `status` when the provider returned one; `message` replaces the default, which
   *   is the classification itself. Keep any message free of prompt and model output (§4).
   */
  constructor(kind: ProviderErrorKind, opts?: {
    status?: number;
    message?: string;
  });
  /** How the call failed. The classification, not the wire detail. */
  readonly kind: ProviderErrorKind;
  /** The HTTP status, when the provider returned one. */
  readonly status?: number;
  /**
   * Reports whether a value is a `ProviderError`, from any copy of this package.
   *
   * Total by construction: every read is inside the `try`, so a throwing getter or a hostile
   * `Proxy` answers `false` rather than escaping into the caller's classification path. The
   * shape is checked as well as the brand.
   */
  static is(value: unknown): value is ProviderError;
}
/** Builds an Anthropic Messages provider. Keys resolve in `prepare()`, not at construction. */
export declare function anthropic(opts: {
  apiKey: ApiKeyResolver;
  baseUrl?: string;
}): Provider;
/** Builds an OpenAI-compatible chat provider. Keys resolve in `prepare()`. */
export declare function openaiCompatible(opts: {
  apiKey: ApiKeyResolver;
  baseUrl?: string;
  jsonMode?: 'native' | 'prompt-only';
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
}): Provider;
/** Builds a Gemini generateContent provider. Keys resolve in `prepare()`. */
export declare function gemini(opts: {
  apiKey: ApiKeyResolver;
}): Provider;
/** Builds an OpenAI Images API provider. Keys resolve in `prepare()`. */
export declare function openaiImages(opts: {
  apiKey: ApiKeyResolver;
  baseUrl?: string;
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}): Provider;
/** Builds an OpenRouter Image API provider. Keys resolve in `prepare()`. */
export declare function openrouterImages(opts: {
  apiKey: ApiKeyResolver;
  baseUrl?: string;
}): Provider;
/**
 * Builds the in-memory config and usage stores (spec §6).
 *
 * State is held in this instance alone: not shared, lost on restart, never pruned.
 *
 * @example
 * ```ts
 * const stores = memoryStores()
 * ```
 */
export declare function memoryStores(): StorePair;
/**
 * Builds the PostgreSQL config and usage stores (spec §6): no query runs at construction, the
 * schema is validated and the database is not touched.
 *
 * @param opts `pool` is your own driver pool, which must run at `READ COMMITTED`
 * (PostgreSQL's default; a stricter level makes concurrent reserves abort rather than deny);
 * `schema` defaults to `llmdispatch` and `leaseMs` to 120 000.
 * @throws `RangeError` when `schema` is not a name llmdispatch may own, or `leaseMs` is outside
 * 5 000–600 000.
 */
export declare function postgresStores(opts: {
  pool: {
    query(sql: string, params?: unknown[]): Promise<{
      rows: unknown[];
    }>;
  };
  schema?: string;
  leaseMs?: number;
}): StorePair;
/**
 * Ties one operation's schemas to its callbacks so inference flows between them.
 *
 * Identity at runtime; the value is the correlation of `In` and `Out` across `prompt`,
 * `quality` and the run result (spec §6). Every entry handed to {@link defineOperations}
 * must be wrapped in this.
 *
 * @param definition The operation exactly as it will run.
 * @returns The same definition, its two schema types correlated.
 */
export declare function defineOperation<In extends z.ZodType, Out extends z.ZodType>(definition: OperationDefinition<In, Out>): OperationDefinition<In, Out>;
/**
 * Collects operations for `createSwitch`.
 *
 * An identity collector (spec §6): it returns exactly the object it was given and does not
 * itself restore inference; that is {@link defineOperation}'s job, per entry.
 *
 * @param operations The map of operations, each wrapped in `defineOperation`.
 * @returns The same object.
 */
export declare function defineOperations<Ops extends OperationsMap>(operations: Ops): Ops;
/**
 * Accepts exactly what the §3 image sub-stage produces: at least one well-formed image and
 * the text beside it. The one-image case is the default; `imageOutputSchema.refine(...)`
 * adds a count or a dimension floor.
 */
export declare const imageOutputSchema: z.ZodType<ImageOutput>;
/**
 * Accepts exactly what the §3 svg sub-stage produces: at least one document and the text
 * beside it. It is the schema of the core's already-normalized output, not an SVG parser,
 * sanitizer or validator of a provider's response: it checks shape only, and the document
 * check has run before it sees anything. `svgOutputSchema.refine(...)` adds a count.
 */
export declare const svgOutputSchema: z.ZodType<SvgOutput>;
/**
 * Builds a configured switch: providers, operations and stores in; `run` plus the admin
 * surface out (spec §6).
 *
 * Construction is pure wiring: no store is called, no provider is prepared, no network is
 * touched, plus the §6 validation of every range and name, so a misconfiguration fails
 * here, loudly, rather than on the first request.
 *
 * @param config Who can be called, what the app does, and where config and counters live.
 * @throws `LLMDispatchError` with code `INVALID_CONFIG` naming the field that failed.
 * @example
 * ```ts
 * const ai = createSwitch({ providers, operations, stores: memoryStores() })
 * const result = await ai.run('summarize', { input: { text }, subjectId: user.id })
 * ```
 */
export declare function createSwitch<Ops extends OperationsMap>(config: CreateSwitchConfig<Ops>): Switch<Ops>;
export type { ApiKeyResolver, AspectRatio, AttemptOutcome, AttemptRecord, ConfigStore, ContentPart, CreateSwitchConfig, FilePart, GeneratedImage, GeneratedImageMediaType, GeneratedSvg, ImageOptions, ImageOutput, ImageSize, Logger, ModelPrice, OperationConfigView, OperationDefinition, OperationRoute, OperationsMap, PreparedProvider, Provider, ProviderErrorKind, ProviderImage, ProviderRequest, ProviderResponse, ProviderSvg, QualityVerdict, QuotaKey, QuotaView, ReservationEnvelope, RouteTarget, RunResult, SettlementFailure, StorePair, SvgOptions, SvgOutput, Switch, TextPart, TokenUsage, UsageStore };
//# sourceMappingURL=index.d.ts.map