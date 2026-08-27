/**
 * Removes values a parent injected into a child from that child's output as it streams through.
 *
 * Defence in depth: runners redact what they print themselves, and this catches what they
 * never see, such as a message from a dependency. A tail of one byte less than the longest
 * secret is held back between chunks so a secret split across two of them still matches.
 *
 * @module
 */

import { StringDecoder } from 'node:string_decoder'

/** Fixed-length replacement, so it says nothing about what it replaced. */
const REPLACEMENT = '[redacted]'

/** Every occurrence of every secret, replaced. */
function redactAll(text, secrets) {
  let result = text
  for (const secret of secrets) result = result.split(secret).join(REPLACEMENT)
  return result
}

/**
 * A writer that redacts secrets out of whatever is pushed through it.
 *
 * @param {string[]} secrets The values to remove. Empty strings are ignored.
 * @param {{ write: (text: string) => unknown }} out Where cleaned text is written.
 * @returns {{ write: (chunk: Buffer) => void, end: () => void }} `write` takes a chunk as it
 *   arrives; `end` flushes whatever is being held back and must be called once.
 */
export function createSecretFilter(secrets, out) {
  const wanted = secrets.filter((secret) => secret.length > 0)
  // A decoder, so a character split across two chunks survives intact.
  const decoder = new StringDecoder('utf8')
  if (wanted.length === 0) {
    return {
      write: (chunk) => {
        out.write(decoder.write(chunk))
      },
      end: () => {
        out.write(decoder.end())
      },
    }
  }

  // Any shorter and the tail of a split secret could be emitted before the rest arrived.
  const held = Math.max(...wanted.map((secret) => secret.length)) - 1
  let pending = ''
  return {
    write(chunk) {
      const cleaned = redactAll(pending + decoder.write(chunk), wanted)
      const emit = cleaned.length > held ? cleaned.slice(0, cleaned.length - held) : ''
      pending = cleaned.slice(emit.length)
      if (emit !== '') out.write(emit)
    },
    end() {
      const rest = redactAll(pending + decoder.end(), wanted)
      pending = ''
      if (rest !== '') out.write(rest)
    },
  }
}
