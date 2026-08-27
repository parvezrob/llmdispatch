/**
 * Removes values a parent injected into a child from that child's output as it streams through.
 *
 * Defence in depth: runners redact what they print themselves, and this catches what they
 * never see, such as a message from a dependency. A tail of one character less than the
 * longest secret is held back between chunks so a secret split across two of them still
 * matches. It is a Transform, so piping it carries backpressure end to end.
 *
 * @module
 */

import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'

/** Fixed-length replacement, so it says nothing about what it replaced. */
const REPLACEMENT = '[redacted]'

/** Every occurrence of every secret, replaced. */
function redactAll(text, secrets) {
  let result = text
  for (const secret of secrets) result = result.split(secret).join(REPLACEMENT)
  return result
}

/**
 * Where to cut `text` so `index` onwards is held back, never between a surrogate pair.
 *
 * A pair split across two writes is decoded as two lone surrogates and reaches the terminal as
 * replacement characters, so an emoji next to the boundary would be corrupted.
 */
function cutBefore(text, index) {
  if (index <= 0) return 0
  const last = text.charCodeAt(index - 1)
  return last >= 0xd800 && last <= 0xdbff ? index - 1 : index
}

/**
 * A Transform that redacts secrets out of the text flowing through it.
 *
 * @param {string[]} secrets The values to remove. Empty strings are ignored.
 * @returns {Transform} A stream to pipe a child's output through.
 */
export function createSecretFilter(secrets) {
  const wanted = secrets.filter((secret) => secret.length > 0)
  // A decoder, so a character split across two chunks survives intact.
  const decoder = new StringDecoder('utf8')
  // Any shorter and the tail of a split secret could be emitted before the rest arrived.
  const held = wanted.length === 0 ? 0 : Math.max(...wanted.map((s) => s.length)) - 1
  let pending = ''

  return new Transform({
    transform(chunk, _encoding, callback) {
      const cleaned = redactAll(pending + decoder.write(chunk), wanted)
      const cut = cutBefore(cleaned, Math.max(cleaned.length - held, 0))
      const emit = cleaned.slice(0, cut)
      pending = cleaned.slice(cut)
      if (emit === '') callback()
      else callback(null, emit)
    },
    flush(callback) {
      const rest = redactAll(pending + decoder.end(), wanted)
      pending = ''
      if (rest === '') callback()
      else callback(null, rest)
    },
  })
}
