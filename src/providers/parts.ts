/**
 * Reading `ProviderRequest.parts` on the way to a wire body, shared by the built-in
 * adapters (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type { ContentPart } from '../types'

/**
 * The text of a request carrying exactly one text part, which every adapter serializes the
 * plain way (§5c).
 *
 * @param parts The request's normalized parts.
 * @returns That part's text, `''` included.
 * @throws `ProviderError` with kind `invalid_request` for any other parts list. The wire
 *   mappings for documents and images are not in place yet, so such a request is rejected
 *   before dispatch rather than serialized as something the model was never sent.
 */
export function readSoleTextPart(parts: readonly ContentPart[]): string {
  const first = parts[0]
  if (parts.length !== 1 || first?.type !== 'text') {
    throw new ProviderError('invalid_request', {
      message: 'only a single text part is supported',
    })
  }
  return first.text
}
