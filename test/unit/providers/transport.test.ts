/**
 * Body settlement is still network I/O (spec §5c): a reset or abort during `response.text()`
 * must classify as `transient` / `aborted`, never leak a raw fetch error that the core would
 * treat as `provider_unclassified`. Unparseable JSON stays a null body, not a network error.
 *
 * The second half holds the adapters' response-side rules, the raster media types, the two
 * response caps and the §6 base64 grammar, to the core definitions they are copied from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import {
  IMAGE_MEDIA_TYPES,
  MAX_RESPONSE_IMAGE_CHARACTERS,
  MAX_RESPONSE_IMAGES,
} from '../../../src/core/image-output'
import { base64Problem } from '../../../src/core/parts'
import {
  fetchJson,
  GENERATED_IMAGE_MEDIA_TYPES,
  isWireBase64,
  MAX_GENERATED_IMAGE_CHARACTERS,
  MAX_GENERATED_IMAGES,
} from '../../../src/providers/transport'

afterEach(() => {
  vi.unstubAllGlobals()
})

const init = {
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: new AbortController().signal,
}

function stubFetch(response: { status: number; text: () => Promise<string> }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response as unknown as Response)),
  )
}

describe('fetchJson body settlement', () => {
  it('classifies a connection reset during body read as transient, never a raw TypeError', async () => {
    stubFetch({
      status: 200,
      text: () => Promise.reject(new TypeError('terminated')),
    })
    await expect(fetchJson('https://example.com/v1', init)).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )
  })

  it('classifies an abort that wins during body read as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort()
        return Promise.resolve({
          status: 200,
          text: () =>
            Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
        } as unknown as Response)
      }),
    )
    await expect(
      fetchJson('https://example.com/v1', { ...init, signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => ProviderError.is(error) && error.kind === 'aborted')
  })

  it('returns a 200 with unparseable JSON as a null body, not a network failure', async () => {
    stubFetch({
      status: 200,
      text: () => Promise.resolve('not-json{'),
    })
    await expect(fetchJson('https://example.com/v1', init)).resolves.toEqual({
      status: 200,
      body: null,
    })
  })
})

/**
 * The adapters keep their own copy of two rules the core also states, because a provider may
 * not import core (`.dependency-cruiser.cjs`). These hold the copies to the originals, so a
 * change on one side cannot pass unnoticed on the other.
 */
describe('the response-side copies of the core rules', () => {
  it('accepts exactly the media types the core accepts', () => {
    expect([...GENERATED_IMAGE_MEDIA_TYPES].sort()).toEqual([...IMAGE_MEDIA_TYPES].sort())
  })

  it('caps a response at the same count and the same length as the core', () => {
    expect(MAX_GENERATED_IMAGES).toBe(MAX_RESPONSE_IMAGES)
    expect(MAX_GENERATED_IMAGE_CHARACTERS).toBe(MAX_RESPONSE_IMAGE_CHARACTERS)
  })

  const corpus: unknown[] = [
    '',
    'AAAA',
    'AAA=',
    'AA==',
    'A===',
    '====',
    '=AAA',
    'AA=A',
    'A=AA',
    'AAA',
    'AAAAA',
    'AAAA=',
    'AAAA\n',
    '\nAAAA',
    'AA AA',
    'AAAA\t',
    'AAAA ',
    'data:image/png;base64,AAAA',
    'data',
    'data:AAA',
    'AAA+',
    'AAA/',
    'AAA-',
    'AAA_',
    'AAAé',
    'AA A',
    'AAAAAAAA',
    'A'.repeat(4000),
    undefined,
    null,
    0,
    1120,
    true,
    {},
    [],
    ['AAAA'],
    new Date(0),
  ]

  it.each(corpus.map((value, index) => [index, value]))(
    'answers the core grammar on corpus entry %i',
    (_index, value) => {
      expect(isWireBase64(value)).toBe(base64Problem(value) === null)
    },
  )
})
