import { z } from "zod";
//#region src/types.d.ts
/** The operations a switch is built from; every entry MUST be wrapped in `defineOperation`. */
type OperationsMap = Record<string, OperationDefinition<z.ZodType, z.ZodType>>;
/** A configured switch: one `run` method plus the admin surface for its runtime config. */
interface Switch<Ops extends OperationsMap> {
  /**
   * Runs one operation end to end and resolves with its validated result.
   *
   * @throws `LLMSwitchError` with the code the final classification maps to (spec §5b).
   */
  run<K extends keyof Ops & string>(operation: K, args: {
    input: z.input<Ops[K]['input']>;
    subjectId?: string;
  }, options?: {
    signal?: AbortSignal;
  }): Promise<RunResult<z.output<Ops[K]['output']>>>;
  getConfig(): Promise<Record<keyof Ops & string, OperationConfigView>>;
  setConfig(operation: keyof Ops & string, route: OperationRoute): Promise<void>;
  resetConfig(operation: keyof Ops & string): Promise<void>;
  getQuota(operation: keyof Ops & string, subjectId: string): Promise<QuotaView>;
}
/** Everything `createSwitch` needs: who can be called, what the app does, where state lives. */
interface CreateSwitchConfig<Ops extends OperationsMap> {
  providers: Record<string, Provider>;
  operations: Ops;
  stores: StorePair;
  pricing?: Record<string, Record<string, ModelPrice>>;
  configTtlMs?: number;
  treatUnclassifiedAsTransient?: boolean;
  fallbackOnAuthOrModelNotFound?: boolean;
  onSettlementError?: (error: unknown, record: SettlementFailure) => void | Promise<void>;
  logger?: Logger;
}
/** What `onSettlementError` is handed: the accounting that could not be written. */
interface SettlementFailure {
  reservation: ReservationEnvelope;
  outcome: 'succeeded' | 'failed';
  attempts: AttemptRecord[];
}
/** The two stores a switch runs on, handed over together. */
interface StorePair {
  config: ConfigStore;
  usage: UsageStore;
}
/** A sink for the package's diagnostics; invoked through caught promise chains. */
interface Logger {
  info(message: string, data?: unknown): void | Promise<void>;
  warn(message: string, data?: unknown): void | Promise<void>;
  error(message: string, data?: unknown): void | Promise<void>;
}
/** One operation: its schemas, its prompt, and the optional gates around them. */
interface OperationDefinition<In extends z.ZodType, Out extends z.ZodType> {
  input: In;
  output: Out;
  prompt: (input: z.output<In>) => string | Promise<string>;
  format?: 'json' | 'json-any' | 'text';
  quality?: (ctx: {
    input: z.output<In>;
    data: z.output<Out>;
  }) => QualityVerdict | Promise<QualityVerdict>;
  quota?: {
    perDay: number;
  };
  timeoutMs?: number;
  defaultRoute?: OperationRoute;
}
/** What a `quality` gate answers: accepted, or rejected with an optional reason. */
type QualityVerdict = {
  ok: true;
} | {
  ok: false;
  reason?: string;
};
/** One operation's stored route: who answers, with what, under which limit. */
interface OperationRoute {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
  quota?: {
    perDay: number;
  };
  fallback?: RouteTarget | null;
}
/** Where a fallback attempt goes: a route without a quota or a fallback of its own. */
interface RouteTarget {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
}
/** What `getConfig` reports per operation: what is stored, and what that resolves to. */
interface OperationConfigView {
  stored: OperationRoute | null | 'malformed';
  effective: OperationRoute | null;
}
/** One subject's standing against one operation's daily limit. */
interface QuotaView {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}
/** What a successful `run` resolves with. */
interface RunResult<Out> {
  data: Out;
  route: {
    provider: string;
    model: string;
  };
  usedFallback: boolean;
  attempts: AttemptRecord[];
  usage: TokenUsage;
  usageComplete: boolean;
  cost: number | null;
}
/** How one dispatched attempt ended, per the §5b classification table. */
type AttemptOutcome = 'succeeded' | 'timeout' | 'truncated' | 'refused' | 'output_rejected' | 'output_schema_error' | 'quality_error' | 'provider_unclassified' | ProviderErrorKind;
/** One dispatched attempt, as it is reported and as it is persisted. */
interface AttemptRecord {
  provider: string;
  model: string;
  outcome: AttemptOutcome;
  status?: number;
  usage: TokenUsage | null;
  costUsd: number | null;
  durationMs: number;
}
/** Provider-reported token counts. Non-negative SAFE integers. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
/** One model's price, per million tokens. Finite, ≥ 0. */
interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}
/** What a provider adapter implements: one call out, optionally with a readiness step. */
interface Provider {
  prepare?(): PreparedProvider | Promise<PreparedProvider>;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
/** What `prepare()` hands back: a dispatcher scoped to one run. */
interface PreparedProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
/** One attempt, as the adapter receives it. */
interface ProviderRequest {
  prompt: string;
  model: string;
  responseFormat: {
    type: 'text';
  } | {
    type: 'json';
    topLevel: 'object' | 'any';
  };
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}
/**
 * What an attempt returned, discriminated by how the provider terminated.
 *
 * Truncation and refusal are billable HTTP-200 terminations, so they travel on the RESPONSE
 * (usage retained), not as thrown errors. `kind: 'complete'` proceeds to the output pipeline;
 * `'truncated'` classifies `truncated`; `'refused'` classifies `refused`.
 */
type ProviderResponse = {
  kind: 'complete';
  text: string;
  usage: TokenUsage | null;
} | {
  kind: 'truncated';
  text: string;
  usage: TokenUsage | null;
} | {
  kind: 'refused';
  text: string;
  usage: TokenUsage | null;
};
/** How an adapter classifies a failure; the classification drives fallback (§5b). */
type ProviderErrorKind = 'transient' | 'rate_limit' | 'auth' | 'model_not_found' | 'invalid_request' | 'aborted' | 'malformed_response';
/** How a built-in adapter reaches its API key, resolved lazily on every run. */
type ApiKeyResolver = () => string | undefined | Promise<string | undefined>;
/** Where routes live. Rows come back verbatim; validating them is the core's job. */
interface ConfigStore {
  getAll(): Promise<Record<string, unknown>>;
  set(operation: string, route: OperationRoute): Promise<void>;
  delete(operation: string): Promise<void>;
}
/** What a daily allowance is counted against: one operation, one subject. */
type QuotaKey = {
  operation: string;
  subjectId: string;
};
/** The store-created handle for one reserved slot. `day`: 'YYYY-MM-DD' UTC, store-chosen. */
interface ReservationEnvelope {
  reservationId: string;
  key: QuotaKey;
  day: string;
}
/** Where quota slots are counted. The store's clock owns the UTC day (§4). */
interface UsageStore {
  reserve(key: QuotaKey, limit: number): Promise<{
    ok: true;
    reservation: ReservationEnvelope;
    expiresAt: string;
  } | {
    ok: false;
    used: number;
    resetsAt: string;
  }>;
  commit(reservationId: string): Promise<'committed' | 'expired' | 'missing'>;
  settle(reservation: ReservationEnvelope, outcome: 'succeeded' | 'failed', attempts: AttemptRecord[]): Promise<void>;
  snapshot(key: QuotaKey): Promise<{
    used: number;
    resetsAt: string;
  }>;
}
//#endregion
//#region src/errors/llmswitch-error.d.ts
/** A classified llmswitch failure: a stable `code`, a literal `retryable`, no content. */
declare class LLMSwitchError extends Error {
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
//#endregion
//#region src/errors/provider-error.d.ts
/** A provider failure, classified by the adapter that saw it (spec §5b). */
declare class ProviderError extends Error {
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
//#endregion
export { type ApiKeyResolver, type AttemptOutcome, type AttemptRecord, type ConfigStore, type CreateSwitchConfig, LLMSwitchError, type Logger, type ModelPrice, type OperationConfigView, type OperationDefinition, type OperationRoute, type OperationsMap, type PreparedProvider, type Provider, ProviderError, type ProviderErrorKind, type ProviderRequest, type ProviderResponse, type QualityVerdict, type QuotaKey, type QuotaView, type ReservationEnvelope, type RouteTarget, type RunResult, type SettlementFailure, type StorePair, type Switch, type TokenUsage, type UsageStore };
//# sourceMappingURL=index.d.ts.map