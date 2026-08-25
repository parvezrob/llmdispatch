/**
 * The error every classified llmswitch failure raises.
 *
 * Adopters catch it and branch on `code`; they never construct it, which is why the
 * constructor is private (spec §6). Inside the package it is reached through `./factories`,
 * so `retryable` is always the literal of the §5a/§5b classification row.
 *
 * @module
 */

import type { AttemptRecord } from '../types'

/** The fields a factory supplies. Not public: the shape an adopter sees is the class. */
interface LLMSwitchErrorInit {
  code: LLMSwitchError['code']
  message: string
  operation: string
  retryable: boolean
  resetsAt?: string
  detectedAt?: 'local' | 'provider'
  attempts?: AttemptRecord[]
  cause?: unknown
}

/**
 * The private constructor, reachable from `./factories` and nowhere else.
 *
 * A class's static block runs with the class's own privileges, so it can hand the constructor
 * to this module without widening it for anyone.
 */
let construct: (init: LLMSwitchErrorInit) => LLMSwitchError

/** A classified failure: a stable `code`, a literal `retryable`, no dispatch content of its own. */
export class LLMSwitchError extends Error {
  private constructor(init: LLMSwitchErrorInit) {
    // Presence, not value: `new Error(m, { cause: undefined })` carries a `cause`, and a
    // caught `undefined` is still something the caller chose to chain.
    super(init.message, 'cause' in init ? { cause: init.cause } : {})
    this.name = 'LLMSwitchError'
    this.code = init.code
    this.operation = init.operation
    this.retryable = init.retryable
    if (init.resetsAt !== undefined) this.resetsAt = init.resetsAt
    if (init.detectedAt !== undefined) this.detectedAt = init.detectedAt
    if (init.attempts !== undefined) this.attempts = init.attempts
  }

  /** What went wrong, as a closed set (spec §5b). */
  declare readonly code:
    | 'INVALID_INPUT'
    | 'MISSING_SUBJECT'
    | 'QUOTA_EXCEEDED'
    | 'USAGE_STORE_UNAVAILABLE'
    | 'CONFIG_STORE_UNAVAILABLE'
    | 'INVALID_CONFIG'
    | 'ABORTED'
    | 'PROVIDER_FAILED'
    | 'OUTPUT_REJECTED'

  /** The operation that failed. */
  declare readonly operation?: string

  /** Literal per §5a/§5b. */
  declare readonly retryable: boolean

  /** When the daily allowance resets, as an ISO instant. `QUOTA_EXCEEDED` carries it. */
  declare readonly resetsAt?: string

  /** Whether an `INVALID_CONFIG` was found locally or reported by the provider. */
  declare readonly detectedAt?: 'local' | 'provider'

  /** Every dispatched attempt, in dispatch order. */
  declare readonly attempts?: AttemptRecord[]

  // Sanitized, scoped to the class's own fields: they never carry prompts, model output,
  // or raw provider errors from a dispatched attempt. A pre-dispatch error may chain the
  // adopter's own thrown store/prepare failure as `cause`, verbatim.

  static {
    construct = (init) => new LLMSwitchError(init)
  }
}

/**
 * Builds an `LLMSwitchError`.
 *
 * @internal Only `./factories` calls this; it is not part of the published surface.
 */
export function constructLLMSwitchError(init: LLMSwitchErrorInit): LLMSwitchError {
  return construct(init)
}
