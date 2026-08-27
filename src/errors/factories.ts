/**
 * The typed constructors for every `LLMDispatchError` the package raises.
 *
 * One factory per classification, not per code: spec §5b makes `retryable` a function of the
 * classification, so `PROVIDER_FAILED` is retryable for a `transient` failure and not for a
 * `refused` one. Taking the classification and looking the literal up is what stops a throw
 * site disagreeing with the table. Messages carry an operation, a field or a classification;
 * never a prompt, a model's output, or a raw provider error (spec §4).
 *
 * @module
 */

import type { AttemptRecord } from '../types'
import { constructLLMDispatchError } from './llmdispatch-error'
import type { LLMDispatchError } from './llmdispatch-error'
import type { ProviderError } from './provider-error'

/** The classifications that end a run as `PROVIDER_FAILED` (spec §5b). */
export type ProviderFailureKind =
  | 'transient'
  | 'rate_limit'
  | 'malformed_response'
  | 'timeout'
  | 'refused'
  | 'invalid_request'
  | 'provider_unclassified'

/** The classifications that end a run as `OUTPUT_REJECTED` (spec §5b). */
export type OutputRejectionKind = 'truncated' | 'output_rejected'

/** The `retryable` column of the §5b rows that end `PROVIDER_FAILED`. */
const providerFailureRetryable: Readonly<Record<ProviderFailureKind, boolean>> = {
  transient: true,
  rate_limit: true,
  malformed_response: true,
  timeout: true,
  refused: false,
  invalid_request: false,
  provider_unclassified: false,
}

/** The `retryable` column of the §5b rows that end `OUTPUT_REJECTED`. */
const outputRejectionRetryable: Readonly<Record<OutputRejectionKind, boolean>> = {
  truncated: true,
  output_rejected: true,
}

/** The input failed the operation's schema, or the operation name is not one of ours. */
export function invalidInput(operation: string, field: string): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'INVALID_INPUT',
    message: `invalid input for "${operation}": ${field}`,
    operation,
    retryable: false,
  })
}

/** The operation has an effective quota, so it cannot run without a subject. */
export function missingSubject(operation: string): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'MISSING_SUBJECT',
    message: `"${operation}" has an effective quota, so it requires a subjectId`,
    operation,
    retryable: false,
  })
}

/** The subject has used its allowance for the store's current UTC day. */
export function quotaExceeded(operation: string, resetsAt: string): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'QUOTA_EXCEEDED',
    message: `"${operation}" is over its daily quota until ${resetsAt}`,
    operation,
    retryable: false,
    resetsAt,
  })
}

/** The usage store did not answer, so the run is refused rather than risked. */
export function usageStoreUnavailable(operation: string, cause: unknown): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'USAGE_STORE_UNAVAILABLE',
    message: `the usage store did not answer, so "${operation}" was refused`,
    operation,
    retryable: true,
    cause,
  })
}

/** The config store did not answer and no fresh route was cached. */
export function configStoreUnavailable(operation: string, cause: unknown): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'CONFIG_STORE_UNAVAILABLE',
    message: `the config store did not answer, so "${operation}" was refused`,
    operation,
    retryable: true,
    cause,
  })
}

/**
 * The configuration is wrong here, before anything was dispatched.
 *
 * @param opts Pass `cause` when a `prepare()` threw something that is not a transient
 *   `ProviderError`. An options object, so chaining a caught `undefined` stays distinguishable
 *   from having nothing to chain.
 */
export function invalidConfigLocal(
  operation: string,
  field: string,
  opts: { cause?: unknown } = {},
): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'INVALID_CONFIG',
    message: `invalid configuration for "${operation}": ${field}`,
    operation,
    retryable: false,
    detectedAt: 'local',
    ...('cause' in opts ? { cause: opts.cause } : {}),
  })
}

/** A `prepare()` threw `ProviderError('transient')`, so the same call may work later (§5a). */
export function invalidConfigTransientPrepare(
  operation: string,
  cause: ProviderError,
): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'INVALID_CONFIG',
    message: `a provider for "${operation}" could not be prepared; the failure is transient`,
    operation,
    retryable: true,
    detectedAt: 'local',
    cause,
  })
}

/** The provider rejected the credentials or the model, after the slot was committed. */
export function invalidConfigProvider(
  operation: string,
  attempts: AttemptRecord[],
): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'INVALID_CONFIG',
    message: `the provider rejected the credentials or model configured for "${operation}"`,
    operation,
    retryable: false,
    detectedAt: 'provider',
    attempts,
  })
}

/** The caller's signal fired; `attempts` only when the run had already dispatched. */
export function aborted(operation: string, attempts?: AttemptRecord[]): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'ABORTED',
    message: `"${operation}" was aborted by its caller`,
    operation,
    retryable: false,
    ...(attempts === undefined ? {} : { attempts }),
  })
}

/** The final attempt failed at the provider; `kind` is the §5b row that decides `retryable`. */
export function providerFailed(
  operation: string,
  kind: ProviderFailureKind,
  attempts: AttemptRecord[],
): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'PROVIDER_FAILED',
    message: `"${operation}" failed at the provider: ${kind}`,
    operation,
    retryable: providerFailureRetryable[kind],
    attempts,
  })
}

/** The final attempt produced output the pipeline rejected (spec §3). */
export function outputRejected(
  operation: string,
  kind: OutputRejectionKind,
  attempts: AttemptRecord[],
): LLMDispatchError {
  return constructLLMDispatchError({
    code: 'OUTPUT_REJECTED',
    message: `"${operation}" produced output that was rejected: ${kind}`,
    operation,
    retryable: outputRejectionRetryable[kind],
    attempts,
  })
}
