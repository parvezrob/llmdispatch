// @targets spec, package
// The response union is discriminated, so an adapter that invents a termination kind or
// mistypes the payload is rejected rather than classified.
import type { ProviderResponse } from 'llmswitch'

// @expect TS2322
export const unknownKind: ProviderResponse = { kind: 'partial', text: '', usage: null }

// @expect TS2322
export const wrongPayload: ProviderResponse = { kind: 'complete', text: 42, usage: null }
