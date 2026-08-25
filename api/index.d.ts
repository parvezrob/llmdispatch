import { C as RunResult, D as TokenUsage, E as Switch, O as UsageStore, S as RouteTarget, T as StorePair, _ as ProviderResponse, b as QuotaView, c as ModelPrice, d as OperationRoute, f as OperationsMap, g as ProviderRequest, h as ProviderErrorKind, i as ConfigStore, l as OperationConfigView, m as Provider, n as AttemptOutcome, o as CreateSwitchConfig, p as PreparedProvider, r as AttemptRecord, s as Logger, t as ApiKeyResolver, u as OperationDefinition, v as QualityVerdict, w as SettlementFailure, x as ReservationEnvelope, y as QuotaKey } from "./types.js";
import { z } from "zod";
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
//#region src/stores/memory/index.d.ts
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
declare function memoryStores(): StorePair;
//#endregion
//#region src/stores/postgres/index.d.ts
/**
 * Builds the PostgreSQL config and usage stores (spec §6): no query runs at construction, the
 * schema is validated and the database is not touched.
 *
 * @param opts `pool` is your own driver pool, which must run at `READ COMMITTED`
 * (PostgreSQL's default; a stricter level makes concurrent reserves abort rather than deny);
 * `schema` defaults to `llmswitch` and `leaseMs` to 120 000.
 * @throws `RangeError` when `schema` is not a name llmswitch may own, or `leaseMs` is outside
 * 5 000–600 000.
 */
declare function postgresStores(opts: {
  pool: {
    query(sql: string, params?: unknown[]): Promise<{
      rows: unknown[];
    }>;
  };
  schema?: string;
  leaseMs?: number;
}): StorePair;
//#endregion
//#region src/core/create-switch.d.ts
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
declare function defineOperation<In extends z.ZodType, Out extends z.ZodType>(definition: OperationDefinition<In, Out>): OperationDefinition<In, Out>;
/**
 * Collects operations for `createSwitch`.
 *
 * An identity collector (spec §6): it returns exactly the object it was given and does not
 * itself restore inference — that is {@link defineOperation}'s job, per entry.
 *
 * @param operations The map of operations, each wrapped in `defineOperation`.
 * @returns The same object.
 */
declare function defineOperations<Ops extends OperationsMap>(operations: Ops): Ops;
//#endregion
//#region src/index.d.ts
/**
 * Builds a configured switch: providers, operations and stores in; `run` plus the admin
 * surface out (spec §6).
 *
 * Construction is pure wiring — no store is called, no provider is prepared, no network is
 * touched — plus the §6 validation of every range and name, so a misconfiguration fails
 * here, loudly, rather than on the first request.
 *
 * @param config Who can be called, what the app does, and where config and counters live.
 * @throws `LLMSwitchError` with code `INVALID_CONFIG` naming the field that failed.
 * @example
 * ```ts
 * const ai = createSwitch({ providers, operations, stores: memoryStores() })
 * const result = await ai.run('summarize', { input: { text }, subjectId: user.id })
 * ```
 */
declare function createSwitch<Ops extends OperationsMap>(config: CreateSwitchConfig<Ops>): Switch<Ops>;
//#endregion
export { type ApiKeyResolver, type AttemptOutcome, type AttemptRecord, type ConfigStore, type CreateSwitchConfig, LLMSwitchError, type Logger, type ModelPrice, type OperationConfigView, type OperationDefinition, type OperationRoute, type OperationsMap, type PreparedProvider, type Provider, ProviderError, type ProviderErrorKind, type ProviderRequest, type ProviderResponse, type QualityVerdict, type QuotaKey, type QuotaView, type ReservationEnvelope, type RouteTarget, type RunResult, type SettlementFailure, type StorePair, type Switch, type TokenUsage, type UsageStore, createSwitch, defineOperation, defineOperations, memoryStores, postgresStores };
//# sourceMappingURL=index.d.ts.map