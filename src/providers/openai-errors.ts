/**
 * The status rows the OpenAI adapters share (spec §5c). `openaiCompatible` and `openaiImages`
 * classify a non-2xx answer the same way; the OpenRouter branch belongs to the compatible
 * transport alone and stays there.
 *
 * @module
 */

import type { ProviderErrorKind } from '../types'
import { classifyByStatusFamily, isRecord } from './transport'

/**
 * Classifies a non-2xx OpenAI answer (§5c). Documented status rows beat a body code: a 429
 * or a 5xx whose body names a missing model is still `rate_limit` or `transient`, and a
 * `model_not_found` code only reclassifies the other 4xx. Pure: it reads the body and throws
 * nothing, so each adapter decides what to do with the answer.
 *
 * @param status The HTTP status of the answer.
 * @param body The parsed body, or `null` when it did not parse.
 * @returns The classification, total over every status.
 */
export function classifyOpenAIStatus(status: number, body: unknown): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 402) return 'rate_limit'
  if (status === 404 || (status >= 400 && status < 500 && isModelNotFound(body))) {
    return 'model_not_found'
  }
  if (status === 408 || status >= 500 || status === 498) return 'transient'
  if (status === 400 || status === 413 || status === 422) return 'invalid_request'
  // Family buckets cover every 4xx/5xx; out-of-range leftovers are transient.
  if (status >= 400 && status < 600) return classifyByStatusFamily(status)
  return 'transient'
}

/** Whether the body's `error` names a missing model by its code or its type. */
function isModelNotFound(body: unknown): boolean {
  if (!isRecord(body)) return false
  const error = body.error
  if (!isRecord(error)) return false
  return error.code === 'model_not_found' || error.type === 'model_not_found'
}
