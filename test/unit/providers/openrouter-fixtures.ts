/**
 * OpenRouter's error bodies as its errors page documents them (spec §5c), shared by every
 * test that holds an adapter to that vocabulary: the envelope `{ error: { code, message,
 * metadata? } }` with a numeric `code`, the three places an `error_type` word may sit, and
 * the moderation answer, which names no type but carries moderation metadata.
 */

/** The documented moderation answer: a 403 whose metadata carries reasons, and no type. */
export const MODERATION_METADATA_BODY = {
  error: {
    code: 403,
    message: 'Your chosen model requires moderation and your input was flagged',
    metadata: {
      reasons: ['violence'],
      flagged_input: 'a flagged prompt',
      provider_name: 'OpenAI',
      model_slug: 'openai/gpt-x',
    },
  },
}

/** Where a documented body puts its `error_type` word. */
export type ErrorTypeLocation =
  'metadata.error_type' | 'error.error_type' | 'top-level error_type'

export const ERROR_TYPE_LOCATIONS: readonly ErrorTypeLocation[] = [
  'metadata.error_type',
  'error.error_type',
  'top-level error_type',
]

/**
 * A documented error body naming `word` in one of the three places: the error's metadata
 * (Chat Completions), the error object itself, or the body's top level.
 */
export function typedErrorBody(
  location: ErrorTypeLocation,
  word: string,
  code = 400,
): Record<string, unknown> {
  const message = 'the request failed'
  if (location === 'metadata.error_type') {
    return { error: { code, message, metadata: { error_type: word } } }
  }
  if (location === 'error.error_type') return { error: { code, message, error_type: word } }
  return { error: { code, message }, error_type: word }
}

/** Documented words that name a moderation block. */
export const MODERATION_WORDS = ['content_policy_violation', 'refusal'] as const

/** Documented words an embedded error classifies `auth` by. */
export const AUTH_WORDS = ['authentication', 'permission_denied'] as const

/** Documented words an embedded error classifies `rate_limit` by. */
export const RATE_LIMIT_WORDS = ['payment_required', 'rate_limit_exceeded'] as const

/** Documented words with no class of their own: an embedded one is `transient`. */
export const OTHER_WORDS = [
  'provider_overloaded',
  'provider_unavailable',
  'server',
  'timeout',
  'unmapped',
  'context_length_exceeded',
  'max_tokens_exceeded',
  'invalid_request',
] as const
