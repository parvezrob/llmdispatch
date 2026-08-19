import { O as UsageStore, a as ConformanceResult, i as ConfigStore, r as AttemptRecord, x as ReservationEnvelope } from "./types.js";
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
export { type ConformanceResult, runConfigStoreConformance, runUsageStoreConformance };
//# sourceMappingURL=conformance.d.ts.map