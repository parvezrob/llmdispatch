/**
 * Reading `ProviderRequest.parts` on the way to a wire body, shared by the built-in
 * adapters (spec §5c).
 *
 * @module
 */

import type { ContentPart } from '../types'

/**
 * The text of a request carrying exactly one text part, which Anthropic and the
 * OpenAI-compatible transport send as a plain string `content` (§5c).
 *
 * @param parts The request's normalized parts.
 * @returns That part's text, `''` included, or `null` for every other parts list, which
 *   both adapters send as an array instead.
 */
export function soleTextPart(parts: readonly ContentPart[]): string | null {
  const first = parts[0]
  if (parts.length !== 1 || first?.type !== 'text') return null
  return first.text
}
