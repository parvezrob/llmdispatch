/**
 * Failure classification: spec §5b's table, applied to whatever an attempt produced.
 *
 * Recognition is `ProviderError.is()`, never bare `instanceof` (dual-package hazard), and
 * `kind` and `status` are each read exactly once into locals immediately afterwards: `is()`
 * itself reads both, so this module's read is the second one, and a getter that mutates or
 * throws on a second read must not move the classification (§2 read-once pin).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type { AttemptOutcome, ProviderErrorKind } from '../types'

/** The §5b classifications an attempt can end with, besides success. */
export type AttemptFailureKind = Exclude<AttemptOutcome, 'succeeded'>

/** The classifications a thrown dispatch failure can produce. */
export type ThrownFailureKind = ProviderErrorKind | 'timeout' | 'provider_unclassified'

/** What classifying a thrown dispatch failure produced. */
export interface ClassifiedThrow {
  kind: ThrownFailureKind
  status: number | undefined
}

const PROVIDER_ERROR_KINDS: ReadonlySet<string> = new Set<ProviderErrorKind>([
  'transient',
  'rate_limit',
  'auth',
  'model_not_found',
  'invalid_request',
  'aborted',
  'malformed_response',
])

/**
 * Classifies a value thrown by `complete()` (spec §5b).
 *
 * A branded `ProviderError` classifies by its captured `kind`; a captured kind outside the
 * closed set, or a second read that throws, follows the `provider_unclassified` row. An
 * adapter-reported `'aborted'` is the caller's abort only if the caller's signal actually
 * fired; otherwise it re-classifies `timeout` (the adapter saw the core's own timeout).
 * Anything else thrown is `provider_unclassified`, or `transient` under
 * `treatUnclassifiedAsTransient`.
 */
export function classifyThrown(
  error: unknown,
  opts: { callerAborted: boolean; treatUnclassifiedAsTransient: boolean },
): ClassifiedThrow {
  if (ProviderError.is(error)) {
    // Each read is guarded on its own: a hostile `status` getter must not be able to move
    // the classification a well-read `kind` decides, and vice versa.
    let kind: unknown
    let status: unknown
    try {
      kind = error.kind
    } catch {
      kind = undefined
    }
    try {
      status = error.status
    } catch {
      status = undefined
    }
    const validStatus = typeof status === 'number' ? status : undefined
    if (typeof kind === 'string' && PROVIDER_ERROR_KINDS.has(kind)) {
      const captured = kind as ProviderErrorKind
      if (captured === 'aborted') {
        return opts.callerAborted
          ? { kind: 'aborted', status: validStatus }
          : { kind: 'timeout', status: validStatus }
      }
      return { kind: captured, status: validStatus }
    }
    return unclassified(opts, validStatus)
  }
  return unclassified(opts, undefined)
}

function unclassified(
  opts: { treatUnclassifiedAsTransient: boolean },
  status: number | undefined,
): ClassifiedThrow {
  return opts.treatUnclassifiedAsTransient
    ? { kind: 'transient', status }
    : { kind: 'provider_unclassified', status }
}

/** The §5b rows that are fallback-eligible unconditionally. */
const ALWAYS_ELIGIBLE: ReadonlySet<AttemptFailureKind> = new Set<AttemptFailureKind>([
  'transient',
  'rate_limit',
  'malformed_response',
  'timeout',
  'truncated',
  'output_rejected',
])

/**
 * Whether a failed attempt's classification allows the fallback attempt (spec §5b).
 *
 * `auth` and `model_not_found` are eligible only on the primary attempt and only under
 * `fallbackOnAuthOrModelNotFound`; nothing else is conditional.
 */
export function isFallbackEligible(
  kind: AttemptFailureKind,
  opts: { isPrimary: boolean; fallbackOnAuthOrModelNotFound: boolean },
): boolean {
  if (ALWAYS_ELIGIBLE.has(kind)) return true
  if (kind === 'auth' || kind === 'model_not_found') {
    return opts.isPrimary && opts.fallbackOnAuthOrModelNotFound
  }
  return false
}
