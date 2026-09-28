/**
 * Reading `ProviderRequest.parts` on the way to a wire body, shared by the built-in
 * adapters (spec §5c).
 *
 * @module
 */

import type { ContentPart, TextPart } from '../types'

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

/**
 * Whether a part is text, as a type guard: the image-only adapters take nothing else, and
 * narrowing here lets them build the prompt from the parts they already checked (§5c).
 *
 * @param part One of the request's normalized parts.
 */
export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === 'text'
}

/**
 * The prompt the image-only adapters send (§5c): the text parts joined with a newline, so a
 * lone part goes verbatim, `''` included.
 *
 * @param parts The request's parts, every one already known to be text.
 * @returns The joined prompt.
 */
export function imagePrompt(parts: readonly TextPart[]): string {
  return parts.map((part) => part.text).join('\n')
}
