/**
 * Body settlement is still network I/O (spec §5c): a reset or abort during `response.text()`
 * must classify as `transient` / `aborted`, never leak a raw fetch error that the core would
 * treat as `provider_unclassified`. Unparseable JSON stays a null body, not a network error.
 *
 * The second half holds the adapters' response-side rules, the raster media types, the two
 * response caps and the §6 base64 grammar, to the core definitions they are copied from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { z } from 'zod'

import { LLMDispatchError, ProviderError } from '../../../src/errors'
import {
  IMAGE_MEDIA_TYPES,
  MAX_RESPONSE_IMAGE_CHARACTERS,
  MAX_RESPONSE_IMAGES,
} from '../../../src/core/image-output'
import { base64Problem } from '../../../src/core/parts'
import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
} from '../../../src/core/svg-document'
import {
  asTokenCount,
  fetchJson,
  GENERATED_IMAGE_MEDIA_TYPES,
  isWireBase64,
  MAX_GENERATED_IMAGE_CHARACTERS,
  MAX_GENERATED_IMAGES,
  MAX_GENERATED_SVG_CHARACTERS,
  MAX_GENERATED_SVG_RESPONSE_CHARACTERS,
  MAX_GENERATED_SVGS,
} from '../../../src/providers/transport'
import {
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  openaiCompatible,
} from '../../../src/index'

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

describe('the network failure message', () => {
  /**
   * A key-shaped fake, assembled at run time so the repository never holds one, and a URL
   * carrying it: neither may reach anything the error holds.
   */
  const FAKE_KEY = ['sk', 'test', '0000example0000'].join('-')
  const KEYED_URL = `https://example.com/v1/images?key=${FAKE_KEY}`

  /** Rejects every fetch with `thrown`, which need not be an `Error`: fetch's own can be any. */
  function rejectFetch(thrown: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(thrown as Error)),
    )
  }

  async function failureOf(): Promise<ProviderError> {
    const error: unknown = await fetchJson('https://example.com/v1', init).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error) && error.kind === 'transient').toBe(true)
    return error as ProviderError
  }

  function withCode(message: string, code: unknown): Error {
    return Object.assign(new Error(message), { code })
  }

  it.each([
    [
      'the code of the cause, as undici throws it',
      new TypeError('fetch failed', { cause: withCode('read ECONNRESET', 'ECONNRESET') }),
      'network failure (ECONNRESET)',
    ],
    [
      'a code on the thrown value itself',
      withCode('connect timeout', 'UND_ERR_CONNECT_TIMEOUT'),
      'network failure (UND_ERR_CONNECT_TIMEOUT)',
    ],
    [
      'the thrown value before its cause',
      Object.assign(new TypeError('fetch failed', { cause: withCode('', 'ENOTFOUND') }), {
        code: 'ECONNRESET',
      }),
      'network failure (ECONNRESET)',
    ],
    [
      "undici's redirect refusal",
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      'network failure (redirect refused)',
    ],
  ])('names %s', async (_label, thrown, message) => {
    rejectFetch(thrown)
    expect((await failureOf()).message).toBe(message)
  })

  it.each([
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ERR_INVALID_URL',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ])('keeps the runtime code %s', async (code) => {
    rejectFetch(new TypeError('fetch failed', { cause: withCode('failed', code) }))
    expect((await failureOf()).message).toBe(`network failure (${code})`)
  })

  it('names the code of a body read that fails', async () => {
    stubFetch({
      status: 200,
      text: () =>
        Promise.reject(
          new TypeError('terminated', {
            cause: withCode('other side closed', 'UND_ERR_SOCKET'),
          }),
        ),
    })
    expect((await failureOf()).message).toBe('network failure (UND_ERR_SOCKET)')
  })

  it.each([
    ['a lower-case code', 'econnreset'],
    ['a one-character code', 'E'],
    ['a code with a space', 'ECONN RESET'],
    ['a code of 65 characters', `E${'X'.repeat(64)}`],
    ['an errno-style code of 25 characters', `E${'X'.repeat(24)}`],
    ['a code carrying a key', FAKE_KEY],
    // Upper-case and well formed, but not a shape the runtime writes: a wrapped fetch can set
    // any code, so the shape is what is checked, not the alphabet.
    ['a key-shaped capital code', ['FAKE', 'API', 'KEY', '123456'].join('_')],
    ['a bare word', 'SECRET'],
    ['a certificate-like code off the list', 'CERT_HAS_EXPIRED_KEY'],
    ['a code carrying a URL', `ECONNRESET ${KEYED_URL}`],
    ['a numeric code', 54],
  ])('drops %s and says only network failure', async (_label, code) => {
    rejectFetch(new TypeError('fetch failed', { cause: withCode('reset', code) }))
    expect((await failureOf()).message).toBe('network failure')
  })

  it.each([
    ['a string', `fetch failed for ${KEYED_URL}`],
    ['null', null],
    ['an error with no code and no cause', new TypeError('fetch failed')],
    ['a cause that is not an object', new TypeError('fetch failed', { cause: 'ECONNRESET' })],
    [
      'a cause naming another redirect failure',
      new TypeError('fetch failed', { cause: new Error('redirect loop') }),
    ],
  ])('says only network failure when %s is thrown', async (_label, thrown) => {
    rejectFetch(thrown)
    expect((await failureOf()).message).toBe('network failure')
  })

  it('never runs a getter on the thrown value or its cause', async () => {
    const getter = vi.fn(() => 'ECONNRESET')
    const cause = Object.defineProperty(new Error('reset'), 'code', { get: getter })
    const thrown = Object.defineProperty(new TypeError('fetch failed'), 'cause', {
      get: getter,
    })
    rejectFetch(thrown)
    expect((await failureOf()).message).toBe('network failure')
    rejectFetch(new TypeError('fetch failed', { cause }))
    expect((await failureOf()).message).toBe('network failure')
    expect(getter).not.toHaveBeenCalled()
  })

  it('says only network failure when reading the cause throws', async () => {
    const hostile = new Proxy(new Error('reset'), {
      getOwnPropertyDescriptor() {
        throw new Error('a trap ran')
      },
    })
    rejectFetch(new TypeError('fetch failed', { cause: hostile }))
    expect((await failureOf()).message).toBe('network failure')
  })

  it('keeps no message, URL, key or reference of the thrown error', async () => {
    const cause = withCode(`connect ECONNREFUSED ${KEYED_URL}`, 'ECONNREFUSED')
    rejectFetch(new TypeError(`fetch failed: ${KEYED_URL}`, { cause }))
    const error = await failureOf()
    expect(error.message).toBe('network failure (ECONNREFUSED)')
    expect(error).not.toHaveProperty('cause')
    const held = [
      String(error),
      error.stack ?? '',
      JSON.stringify(error),
      ...Object.getOwnPropertyNames(error).map((name) =>
        String((error as unknown as Record<string, unknown>)[name]),
      ),
    ].join('\n')
    for (const leaked of [FAKE_KEY, 'example.com', 'key=']) expect(held).not.toContain(leaked)
  })

  // The detail lives in the adapter's ProviderError only: the attempt record has no field for
  // it (spec §6), and the run's own error carries the classification, never the wire detail.
  it('leaves nothing of the thrown error in what run() rejects with', async () => {
    const cause = withCode(`connect ECONNRESET ${KEYED_URL}`, 'ECONNRESET')
    rejectFetch(new TypeError(`fetch failed: ${KEYED_URL}`, { cause }))
    const ai = createSwitch({
      providers: { openai: openaiCompatible({ apiKey: () => FAKE_KEY }) },
      operations: defineOperations({
        ask: defineOperation({
          input: z.object({}),
          output: z.string(),
          prompt: () => 'hello',
          format: 'text',
          defaultRoute: { provider: 'openai', model: 'gpt-x' },
        }),
      }),
      stores: memoryStores(),
    })
    const error: unknown = await ai.run('ask', { input: {} }).then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(LLMDispatchError)
    const failed = error as LLMDispatchError
    expect(failed.code).toBe('PROVIDER_FAILED')
    expect(failed.retryable).toBe(true)
    expect(failed.attempts).toEqual([expect.objectContaining({ outcome: 'transient' })])
    const held = [failed.message, failed.stack ?? '', JSON.stringify(failed)].join('\n')
    for (const leaked of [FAKE_KEY, 'example.com', 'key=']) expect(held).not.toContain(leaked)
    expect(failed).not.toHaveProperty('cause')
  })

  it('still reports an abort as aborted, whatever code the rejection carries', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort()
        return Promise.reject(withCode('aborted', 'ECONNRESET'))
      }),
    )
    const error: unknown = await fetchJson('https://example.com/v1', {
      ...init,
      signal: controller.signal,
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error) && error.kind === 'aborted').toBe(true)
    expect((error as ProviderError).message).toBe('request aborted')
  })
})

describe('asTokenCount', () => {
  // `JSON.parse('-0')` is `-0`, which passes a `>= 0` check: a count read from the wire must
  // still come back unsigned, or `Object.is` and a stored record could tell the two apart.
  it('reads -0 as 0', () => {
    expect(Object.is(asTokenCount(-0), 0)).toBe(true)
    expect(Object.is(asTokenCount(JSON.parse('-0')), 0)).toBe(true)
  })

  it('keeps 0 and a positive count as they are', () => {
    expect(Object.is(asTokenCount(0), 0)).toBe(true)
    expect(asTokenCount(1200)).toBe(1200)
  })
})

/**
 * The adapters keep their own copies of rules the core also states, because a provider may
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

  it('caps an svg response at the same count, document length and total as the core', () => {
    expect(MAX_GENERATED_SVGS).toBe(MAX_RESPONSE_SVGS)
    expect(MAX_GENERATED_SVG_CHARACTERS).toBe(MAX_SVG_CHARACTERS)
    expect(MAX_GENERATED_SVG_RESPONSE_CHARACTERS).toBe(MAX_RESPONSE_SVG_CHARACTERS)
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
