import { describe, expect, it } from 'vitest'

import { createSecretFilter } from '../../../scripts/lib/secret-filter.mjs'

/**
 * What a filter lets through, given the chunks it was written.
 *
 * The output is collected as bytes and decoded once at the end, exactly as a terminal reads
 * it. Decoding each write on its own would paper over a character split across two of them.
 */
async function through(secrets: string[], chunks: Buffer[]): Promise<string> {
  const filter = createSecretFilter(secrets)
  const written: Buffer[] = []
  filter.on('data', (chunk: Buffer) => {
    written.push(Buffer.from(chunk))
  })
  const ended = new Promise((resolve) => filter.on('end', resolve))
  for (const chunk of chunks) filter.write(chunk)
  filter.end()
  await ended
  return Buffer.concat(written).toString('utf8')
}

/** Each string as one chunk. */
function chunks(...text: string[]): Buffer[] {
  return text.map((piece) => Buffer.from(piece, 'utf8'))
}

/**
 * One chunk per character, so every character boundary is exercised.
 *
 * By code point, not by code unit: a lone surrogate is not encodable, so splitting a pair here
 * would corrupt it before the filter ever saw it. A real stream delivers bytes, which
 * `perByte` covers.
 */
function perCharacter(text: string): Buffer[] {
  const characters: Buffer[] = []
  for (const character of text) characters.push(Buffer.from(character, 'utf8'))
  return characters
}

/** One chunk per byte, so every byte boundary is exercised. */
function perByte(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8')
  return Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1))
}

describe('the child output secret filter', () => {
  it('passes output through unchanged when it holds no secret', async () => {
    expect(await through(['sk-key'], chunks('hello ', 'world\n'))).toBe('hello world\n')
  })

  it('replaces a secret inside one chunk', async () => {
    expect(await through(['sk-key'], chunks('auth failed for sk-key\n'))).toBe(
      'auth failed for [redacted]\n',
    )
  })

  it('replaces a secret split across two chunks', async () => {
    expect(await through(['sk-secret-value'], chunks('token=sk-secret', '-value done\n'))).toBe(
      'token=[redacted] done\n',
    )
  })

  it('replaces a secret split one character at a time', async () => {
    const secret = 'sk-abcdef'
    expect(await through([secret], perCharacter(`before ${secret} after\n`))).toBe(
      'before [redacted] after\n',
    )
  })

  it('replaces every occurrence, and handles several secrets', async () => {
    expect(await through(['aaa', 'bbb'], chunks('x aaa y bbb z aaa\n'))).toBe(
      'x [redacted] y [redacted] z [redacted]\n',
    )
  })

  it('flushes what it was holding back when the stream ends', async () => {
    expect(await through(['sk-long-secret'], chunks('tail'))).toBe('tail')
  })

  it('keeps an astral character whole when the held-back tail falls inside it', async () => {
    // A three-character secret holds back two characters, which for `A😀B` is the second half
    // of the surrogate pair and the `B`: cutting there would emit a lone high surrogate.
    expect(await through(['key'], chunks('A😀B'))).toBe('A😀B')
    expect(await through(['key'], perCharacter('A😀B'))).toBe('A😀B')
    expect(await through(['key'], chunks('x😀', '😀y'))).toBe('x😀😀y')
  })

  it('does not split a multi-byte character across chunks', async () => {
    expect(await through(['sk-key'], perByte('héllo ✓ 😀\n'))).toBe('héllo ✓ 😀\n')
  })

  it('passes output through when there is no secret to remove', async () => {
    expect(await through([], chunks('anything at all\n'))).toBe('anything at all\n')
    expect(await through([''], chunks('anything at all\n'))).toBe('anything at all\n')
  })
})
