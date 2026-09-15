import { z } from "zod";
//#region src/types.d.ts
/** The operations a switch is built from; every entry MUST be wrapped in `defineOperation`. */
type OperationsMap = Record<string, OperationDefinition<z.ZodType, z.ZodType>>;
/** A configured switch: one `run` method plus the admin surface for its runtime config. */
interface Switch<Ops extends OperationsMap> {
  /**
   * Runs one operation end to end and resolves with its validated result.
   *
   * @throws `LLMDispatchError` with the code the final classification maps to (spec §5b).
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
/** One run of text in a request. Any string is legal, `''` included. */
interface TextPart {
  readonly type: 'text';
  readonly text: string;
}
/** One document or image in a request, carried inline as base64 (§6 normalization and caps). */
interface FilePart {
  readonly type: 'file';
  readonly mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  readonly data: string;
  readonly filename?: string;
}
/** What a request is made of, in the order the model should see it. */
type ContentPart = TextPart | FilePart;
/** The aspect ratios every built-in image adapter accepts (§6). */
type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3';
/** A provider-relative resolution class (§6), never a pixel promise. */
type ImageSize = '1K' | '2K' | '4K';
/** The knobs an image operation declares (§6). Every one is optional; an unset knob never reaches the wire. */
interface ImageOptions {
  readonly count?: number;
  readonly aspectRatio?: AspectRatio;
  readonly size?: ImageSize;
  readonly background?: 'transparent' | 'opaque';
}
/** The raster types a generated image may come back as (§6). */
type GeneratedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
/**
 * One generated image as an adapter hands it back (§6): base64 under the request grammar,
 * with its pixel dimensions either both stated or both left for the core to read from the
 * image header.
 */
type ProviderImage = {
  readonly mediaType: GeneratedImageMediaType;
  readonly data: string;
} & ({
  readonly width: number;
  readonly height: number;
} | {
  readonly width?: undefined;
  readonly height?: undefined;
});
/** One generated image as an adopter receives it: a file part that also states its pixel size. */
interface GeneratedImage {
  readonly type: 'file';
  readonly mediaType: GeneratedImageMediaType;
  readonly data: string;
  readonly width: number;
  readonly height: number;
}
/** What an image operation's output schema receives (§3): the images, and any text beside them. */
interface ImageOutput {
  readonly images: readonly GeneratedImage[];
  readonly text: string;
}
/** One operation: its schemas, its prompt, and the optional gates around them. */
interface OperationDefinition<In extends z.ZodType, Out extends z.ZodType> {
  input: In;
  output: Out;
  prompt: (input: z.output<In>) => string | readonly ContentPart[] | Promise<string | readonly ContentPart[]>;
  format?: 'json' | 'json-any' | 'text' | 'image';
  image?: ImageOptions;
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
  imageOutputTokens?: number;
}
/** One model's price, per million tokens. Finite, ≥ 0. */
interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  imageOutputPerM?: number;
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
/** One attempt, as the adapter receives it. `parts` is normalized, non-empty and frozen. */
interface ProviderRequest {
  parts: readonly ContentPart[];
  model: string;
  responseFormat: {
    type: 'text';
  } | {
    type: 'json';
    topLevel: 'object' | 'any';
  } | ({
    type: 'image';
  } & ImageOptions);
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}
/**
 * What an attempt returned, discriminated by how the provider terminated.
 *
 * Truncation and refusal are billable terminations the adapter normalizes from a success or
 * an error response (§5c), so they travel on the RESPONSE (usage retained), not as thrown
 * errors. `kind: 'complete'` proceeds to the output pipeline; `'truncated'` classifies
 * `truncated`; `'refused'` classifies `refused`. `images` is read only for an image-format
 * operation (§3). `costUsd` is the provider's own charge for the attempt and, when it is a
 * finite non-negative number, is authoritative over the pricing table (§7).
 */
type ProviderResponse = {
  kind: 'complete';
  text: string;
  usage: TokenUsage | null;
  images?: readonly ProviderImage[];
  costUsd?: number;
} | {
  kind: 'truncated';
  text: string;
  usage: TokenUsage | null;
  costUsd?: number;
} | {
  kind: 'refused';
  text: string;
  usage: TokenUsage | null;
  costUsd?: number;
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
/** What a conformance run reports. `passed` is true exactly when `failures` is empty. */
interface ConformanceResult {
  passed: boolean;
  failures: string[];
  skipped: string[];
}
//#endregion
export { ReservationEnvelope as A, ProviderErrorKind as C, QualityVerdict as D, ProviderResponse as E, Switch as F, TextPart as I, TokenUsage as L, RunResult as M, SettlementFailure as N, QuotaKey as O, StorePair as P, UsageStore as R, Provider as S, ProviderRequest as T, OperationConfigView as _, ConfigStore as a, OperationsMap as b, CreateSwitchConfig as c, GeneratedImageMediaType as d, ImageOptions as f, ModelPrice as g, Logger as h, AttemptRecord as i, RouteTarget as j, QuotaView as k, FilePart as l, ImageSize as m, AspectRatio as n, ConformanceResult as o, ImageOutput as p, AttemptOutcome as r, ContentPart as s, ApiKeyResolver as t, GeneratedImage as u, OperationDefinition as v, ProviderImage as w, PreparedProvider as x, OperationRoute as y };
//# sourceMappingURL=types.d.ts.map