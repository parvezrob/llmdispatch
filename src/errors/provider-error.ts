/**
 * The error a provider adapter throws to say how a call failed.
 *
 * Its `kind` drives the fallback matrix (spec §5b), so recognising one must work even when
 * the thrower and the reader loaded different copies of this module — the dual-package
 * hazard. Recognition is therefore brand-based, and `ProviderError.is()` is the only
 * supported check; bare `instanceof` is never used.
 *
 * @module
 */

import type { ProviderErrorKind } from '../types'

/** The recognition brand: one symbol per process, whichever copy or realm asks for it. */
const brand: unique symbol = Symbol.for('llmswitch.ProviderError')

/** The closed set from spec §6; `satisfies` makes a kind added to the union a compile error. */
const kinds = {
  transient: true,
  rate_limit: true,
  auth: true,
  model_not_found: true,
  invalid_request: true,
  aborted: true,
  malformed_response: true,
} satisfies Record<ProviderErrorKind, true>

/** A provider failure, classified by the adapter that saw it (spec §5b). */
export class ProviderError extends Error {
  /**
   * Classifies a failed provider call.
   *
   * @param kind The §5b row that describes what happened; it decides whether the run falls back.
   * @param opts `status` when the provider returned one; `message` replaces the default, which
   *   is the classification itself. Keep any message free of prompt and model output (§4).
   */
  constructor(kind: ProviderErrorKind, opts?: { status?: number; message?: string }) {
    super(opts?.message ?? `provider error: ${kind}`)
    this.name = 'ProviderError'
    this.kind = kind
    if (opts?.status !== undefined) this.status = opts.status
  }

  /** How the call failed. The classification, not the wire detail. */
  declare readonly kind: ProviderErrorKind

  /** The HTTP status, when the provider returned one. */
  declare readonly status?: number

  /**
   * Reports whether a value is a `ProviderError`, from any copy of this package.
   *
   * Total by construction: every read is inside the `try`, so a throwing getter or a hostile
   * `Proxy` answers `false` rather than escaping into the caller's classification path. The
   * shape is checked as well as the brand.
   */
  static is(value: unknown): value is ProviderError {
    try {
      if (typeof value !== 'object' || value === null) return false
      const candidate = value as Record<PropertyKey, unknown>
      if (candidate[brand] !== true) return false
      const kind = candidate.kind
      if (typeof kind !== 'string' || !Object.hasOwn(kinds, kind)) return false
      if (typeof candidate.message !== 'string') return false
      const status = candidate.status
      return status === undefined || typeof status === 'number'
    } catch {
      return false
    }
  }

  static {
    // On the prototype and non-enumerable, so it costs nothing per error and never shows up
    // in a spread or a log line. A class member would change the published declaration.
    Object.defineProperty(this.prototype, brand, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
}
