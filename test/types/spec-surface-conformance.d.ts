// Generated from the code fences of docs/spec.md by scripts/check-spec-surface.mjs.
// Edit the spec, then run `npm run surface:update`.

import type { AttemptRecord, ConfigStore, Provider, ProviderRequest, ReservationEnvelope, UsageStore } from './spec-surface'

// subpath: llmswitch/conformance
export interface ConformanceResult { passed: boolean; failures: string[]; skipped: string[] }
export declare function runUsageStoreConformance(opts: {
  // create returns the store under test plus REQUIRED test controls:
  // setTime drives the STORE's authoritative clock (for Postgres: a session/test hook the
  // adapter documents) and is called with non-decreasing instants between reset() calls;
  // reset wipes state; readSettled exposes what settle() persisted so
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
}): Promise<ConformanceResult>  // passed === (failures.length === 0); skipped is informational
