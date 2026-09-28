/**
 * OpenRouter's error envelope (spec §5c), recognised the same way by every adapter that
 * speaks it: `openaiCompatible` for an OpenRouter host, and `openrouterImages` for any base
 * URL. Recognition only: which answers speak the envelope is each adapter's call, so nothing
 * here takes a host, and the status rows stay in `openai-errors.ts`.
 *
 * The vocabulary is the one OpenRouter documents: `{ error: { code, message, metadata? } }`
 * with a numeric `code`, an `error_type` word in one of three places, and a moderation answer
 * that names no type at all but carries moderation metadata.
 *
 * @module
 */

import { isRecord } from './transport'

/** What an error OpenRouter embeds in a 2xx answer classifies as (§5c). */
export type EmbeddedErrorKind = 'refused' | 'auth' | 'rate_limit' | 'transient'

/** The error-type words that name a moderation block (§5c). */
const MODERATION_WORDS: ReadonlySet<string> = new Set([
  'moderation',
  'content_policy_violation',
  'refusal',
])

/** The error-type words an embedded error classifies `auth` by (§5c). */
const AUTH_WORDS: ReadonlySet<string> = new Set(['authentication', 'auth', 'permission_denied'])

/** The error-type words an embedded error classifies `rate_limit` by (§5c). */
const RATE_LIMIT_WORDS: ReadonlySet<string> = new Set([
  'payment_required',
  'rate_limit_exceeded',
  'credit',
  'rate_limit',
  'rate-limit',
])

/**
 * The word an OpenRouter body names its error by (§5c), or `undefined` when it names none.
 * The error is the first choice's `error` object when there is one, else the top-level
 * `error`. The word is the first string among its `metadata.error_type`, its `error_type`,
 * the body's own top-level `error_type`, then its `metadata.code`, `code` and `type`, in that
 * order. OpenRouter's `code` is the HTTP status as a number, so it names nothing.
 *
 * @param body The parsed body, of any shape.
 * @returns The error-type word, or `undefined`.
 */
export function openRouterErrorType(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = selectedError(body)
  const meta = error !== null && isRecord(error.metadata) ? error.metadata : null
  const candidates = [
    meta?.error_type,
    error?.error_type,
    body.error_type,
    meta?.code,
    error?.code,
    error?.type,
  ]
  return candidates.find((value): value is string => typeof value === 'string')
}

/**
 * Whether a body is OpenRouter's moderation envelope (§5c): its error-type word is
 * `moderation`, `content_policy_violation` or `refusal`, or its error's `metadata` is
 * moderation metadata. OpenRouter's documented moderation answer names no type, so the
 * metadata alone must be enough. On a 403 that makes the answer the content's fault rather
 * than the key's; embedded in a 2xx it is a refusal.
 *
 * @param body The parsed body, of any shape.
 */
export function isOpenRouterModeration(body: unknown): boolean {
  if (!isRecord(body)) return false
  const type = openRouterErrorType(body)
  if (type !== undefined && MODERATION_WORDS.has(type)) return true
  const error = selectedError(body)
  return error !== null && isModerationMetadata(error.metadata)
}

/**
 * Moderation metadata (§5c): OpenRouter's documented shape carries `reasons` (an array),
 * `flagged_input` (a string), `provider_name` and `model_slug`. Either of the first two is
 * enough; no other error OpenRouter documents carries them.
 */
function isModerationMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Array.isArray(value.reasons) || typeof value.flagged_input === 'string'
}

/** The error object a body names: the first choice's, else the top-level one. */
function selectedError(body: Record<string, unknown>): Record<string, unknown> | null {
  return firstChoiceError(body) ?? (isRecord(body.error) ? body.error : null)
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
 * at the top level or on the first choice. A moderation envelope is `refused`; otherwise the
 * error-type word classifies it: `authentication`, `auth` or `permission_denied` → `auth`;
 * `payment_required`, `rate_limit_exceeded`, `credit`, `rate_limit` or `rate-limit` →
 * `rate_limit`; any other word, or none → `transient`.
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

  if (isOpenRouterModeration(body)) return 'refused'
  const type = openRouterErrorType(body)
  if (type === undefined) return 'transient'
  if (AUTH_WORDS.has(type)) return 'auth'
  if (RATE_LIMIT_WORDS.has(type)) return 'rate_limit'
  return 'transient'
}
