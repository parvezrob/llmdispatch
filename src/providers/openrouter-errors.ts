/**
 * OpenRouter's error envelope (spec §5c), recognised the same way by every adapter that
 * speaks it: `openaiCompatible` for an OpenRouter host, and `openrouterImages` for any base
 * URL. Recognition only: which answers speak the envelope is each adapter's call, so nothing
 * here takes a host, and the status rows stay in `openai-errors.ts`.
 *
 * @module
 */

import { isRecord } from './transport'

/** What an error OpenRouter embeds in a 2xx answer classifies as (§5c). */
export type EmbeddedErrorKind = 'refused' | 'auth' | 'rate_limit' | 'transient'

/**
 * The word an OpenRouter body names its error by (§5c), or `undefined` when it names none.
 * The error is the first choice's `error` object when there is one, else the top-level
 * `error`; within it the first string among `metadata.error_type`, `metadata.code`, `code`
 * and `type`, in that order.
 *
 * @param body The parsed body, of any shape.
 * @returns The error-type word, or `undefined`.
 */
export function openRouterErrorType(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const fromChoice = firstChoiceError(body)
  const error = fromChoice ?? (isRecord(body.error) ? body.error : null)
  if (error === null) return undefined
  const meta = isRecord(error.metadata) ? error.metadata : null
  if (meta !== null) {
    if (typeof meta.error_type === 'string') return meta.error_type
    if (typeof meta.code === 'string') return meta.code
  }
  if (typeof error.code === 'string') return error.code
  if (typeof error.type === 'string') return error.type
  return undefined
}

/**
 * Whether a body is OpenRouter's moderation envelope (§5c): its error-type word is
 * `moderation`. On a 403 that makes the answer the content's fault rather than the key's.
 *
 * @param body The parsed body, of any shape.
 */
export function isOpenRouterModeration(body: unknown): boolean {
  return openRouterErrorType(body) === 'moderation'
}

/** The first choice's `error` object, when the body has choices and it has one. */
function firstChoiceError(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.choices) || body.choices.length === 0) return null
  const first: unknown = body.choices[0]
  if (!isRecord(first) || !isRecord(first.error)) return null
  return first.error
}

/**
 * An error OpenRouter embeds in a 2xx answer (§5c), or `null` when there is none. One is
 * present when the first choice says `finish_reason: 'error'` or when an `error` object sits
 * at the top level or on the first choice. Its error-type word then classifies it:
 * `moderation` → `refused`; `auth` or `authentication` → `auth`; `credit`, `rate_limit` or
 * `rate-limit` → `rate_limit`; anything else, a missing word included → `transient`.
 *
 * @param body A 2xx body already known to be an object.
 * @returns The classification, or `null` for an answer that embeds no error.
 */
export function classifyEmbeddedError(body: Record<string, unknown>): EmbeddedErrorKind | null {
  const choices = body.choices
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null
  const hasErrorFinish = choice?.finish_reason === 'error'
  const topError = isRecord(body.error) ? body.error : null
  const choiceError = choice !== null && isRecord(choice.error) ? choice.error : null
  if (!hasErrorFinish && topError === null && choiceError === null) return null

  const type = openRouterErrorType(body)
  if (type === 'moderation') return 'refused'
  if (type === 'auth' || type === 'authentication') return 'auth'
  if (type === 'credit' || type === 'rate_limit' || type === 'rate-limit') return 'rate_limit'
  return 'transient'
}
