import { describe, expect, it } from 'vitest'

import { createSecretFilter } from '../../../scripts/lib/secret-filter.mjs'

/** Collects what a filter lets through, given the chunks it was written. */
function through(secrets: string[], chunks: string[]): string {
  let written = ''
  const filter = createSecretFilter(secrets, {
    write: (text: string) => {
      written += text
    },
  })
  for (const chunk of chunks) filter.write(Buffer.from(chunk, 'utf8'))
  filter.end()
  return written
}

describe('the child output secret filter', () => {
  it('passes output through unchanged when it holds no secret', () => {
    expect(through(['sk-key'], ['hello ', 'world\n'])).toBe('hello world\n')
  })

  it('replaces a secret inside one chunk', () => {
    expect(through(['sk-key'], ['auth failed for sk-key\n'])).toBe(
      'auth failed for [redacted]\n',
    )
  })

  it('replaces a secret split across two chunks', () => {
    expect(through(['sk-secret-value'], ['token=sk-secret', '-value done\n'])).toBe(
      'token=[redacted] done\n',
    )
  })

  it('replaces a secret split one character at a time', () => {
    const secret = 'sk-abcdef'
    const text = `before ${secret} after\n`
    const chunks = Array.from({ length: text.length }, (_, index) => text[index] ?? '')
    expect(through([secret], chunks)).toBe('before [redacted] after\n')
  })

  it('replaces every occurrence, and handles several secrets', () => {
    expect(through(['aaa', 'bbb'], ['x aaa y bbb z aaa\n'])).toBe(
      'x [redacted] y [redacted] z [redacted]\n',
    )
  })

  it('flushes what it was holding back when the stream ends', () => {
    expect(through(['sk-long-secret'], ['tail'])).toBe('tail')
  })

  it('does not split a multi-byte character across chunks', () => {
    const bytes = Buffer.from('héllo ✓\n', 'utf8')
    let written = ''
    const filter = createSecretFilter(['sk-key'], {
      write: (text: string) => {
        written += text
      },
    })
    for (const byte of bytes) filter.write(Buffer.from([byte]))
    filter.end()
    expect(written).toBe('héllo ✓\n')
  })

  it('passes output through when there is no secret to remove', () => {
    expect(through([], ['anything at all\n'])).toBe('anything at all\n')
    expect(through([''], ['anything at all\n'])).toBe('anything at all\n')
  })
})
