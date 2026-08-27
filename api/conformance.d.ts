import { C as ReservationEnvelope, a as ConformanceResult, g as Provider, i as ConfigStore, j as UsageStore, r as AttemptRecord, v as ProviderRequest } from "./types.js";
//#region src/conformance/config-store.d.ts
/**
 * Checks a `ConfigStore` against the behaviour spec §8 requires of one.
 *
 * Framework-free: call it from any test runner or from a script, and read the result. Every
 * case starts from `reset()`, so the verdict does not depend on the order anything ran in.
 *
 * @param opts `create` builds the store under test, plus `seedRaw` for writing rows no
 *   `set` would produce.
 * @returns Every failure, each prefixed with the case that reported it.
 *
 * @example
 * ```ts
 * const result = await runConfigStoreConformance({ create: () => buildMyStore() })
 * if (!result.passed) throw new Error(result.failures.join('\n'))
 * ```
 */
declare function runConfigStoreConformance(opts: {
  create(): Promise<{
    store: ConfigStore;
    reset(): Promise<void>;
    seedRaw(operation: string, value: unknown): Promise<void>;
  }>;
}): Promise<ConformanceResult>;
//#endregion
//#region src/conformance/usage-store.d.ts
/**
 * Checks a `UsageStore` against the behaviour spec §8 requires of one.
 *
 * Framework-free: call it from any test runner or from a script, and read the result. Every
 * case starts from `reset()` and a fixed clock, so the verdict does not depend on the order
 * anything ran in. `setTime` is only ever called with instants that do not move the store's
 * clock backwards between resets. The store's lease must be at least 100 ms and short enough
 * to lapse before the store's day ends, which is checked first and reported as `lease-window`.
 *
 * @param opts `create` builds the store under test and the controls the suite drives it with.
 * @returns Every failure, each prefixed with the case that reported it.
 *
 * @example
 * ```ts
 * const result = await runUsageStoreConformance({ create: () => buildMyStore() })
 * if (!result.passed) throw new Error(result.failures.join('\n'))
 * ```
 */
declare function runUsageStoreConformance(opts: {
  create(): Promise<{
    store: UsageStore;
    setTime(date: Date): Promise<void>;
    reset(): Promise<void>;
    readSettled(reservationId: string): Promise<{
      reservation: ReservationEnvelope;
      outcome: string;
      attempts: AttemptRecord[];
    } | null>;
  }>;
}): Promise<ConformanceResult>;
//#endregion
//#region src/conformance/provider.d.ts
/** Optional classification scenarios the harness can drive when the adopter supplies them. */
type OptionalScenario = 'auth' | 'rate_limit' | 'model_not_found' | 'invalid_request' | 'transient' | 'malformed_response' | 'truncated' | 'refused';
/** Optional media scenarios: success-class conditions dispatching a request that carries a file. */
type MediaScenario = 'document' | 'image';
/** Controls that let the suite verify responseFormat and capability without guessing. */
interface ProviderConformanceControls {
  /** Declares whether the provider under test supports native JSON mode. */
  jsonCapability?: 'native' | 'prompt-only';
  /** Observes each request the harness dispatches. */
  observeRequest?: (req: ProviderRequest) => void;
}
/**
 * Checks a `Provider` against the behaviour spec §8 requires of one.
 *
 * `success` is mandatory. Absent optional scenarios are reported in `skipped` (unverified).
 * A media scenario also needs its request in `requests`; either half absent and it is skipped.
 * `passed` is true exactly when `failures` is empty.
 */
declare function runProviderConformance(opts: {
  provider: Provider;
  requestFactory: () => ProviderRequest;
  scenarios: {
    success: () => Promise<void>;
  } & Partial<Record<OptionalScenario | MediaScenario, () => Promise<void>>>;
  requests?: Partial<Record<MediaScenario, () => ProviderRequest>>;
  controls?: ProviderConformanceControls;
}): Promise<ConformanceResult>;
//#endregion
export { type ConformanceResult, runConfigStoreConformance, runProviderConformance, runUsageStoreConformance };
//# sourceMappingURL=conformance.d.ts.map