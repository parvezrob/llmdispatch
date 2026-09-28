import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { openaiImages } from '../../../src/providers/openai-images'
import { isWireBase64 } from '../../../src/providers/transport'
import type * as transportModule from '../../../src/providers/transport'
import type {
  AspectRatio,
  ContentPart,
  ImageOptions,
  ImageSize,
  ProviderRequest,
} from '../../../src/types'
import { base64, png } from '../core/image-fixtures'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  SENTINEL,
  textParts,
  withPrepared,
} from './helpers'

// The module keeps its real behaviour; the wrapper only makes the grammar scan observable,
// so the cap tests can show what the adapter never reaches. Vitest hoists this above the
// imports above.
vi.mock('../../../src/providers/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof transportModule>()
  return { ...actual, isWireBase64: vi.fn(actual.isWireBase64) }
})

const KEY = () => 'sk-images-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Options = Parameters<typeof openaiImages>[0]

async function complete(opts: Partial<Options> = {}) {
  return withPrepared(openaiImages({ apiKey: KEY, ...opts }))
}

const PNG_DATA = base64(png(2, 3))

function imageRequest(image: ImageOptions = {}, overrides: Partial<ProviderRequest> = {}) {
  return baseRequest({ responseFormat: { type: 'image', ...image }, ...overrides })
}

/** A generations answer: one element per `b64_json`, plus any top-level fields. */
function imagesBody(
  extra: Record<string, unknown> = {},
  data: unknown[] = [{ b64_json: PNG_DATA }],
) {
  return { created: 1_700_000_000, data, ...extra }
}

/** The body the adapter sent for one image request, answered with one image. */
async function sentBody(
  image: ImageOptions = {},
  opts: Partial<Options> = {},
  overrides: Partial<ProviderRequest> = {},
): Promise<Record<string, unknown>> {
  const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
  const run = await complete(opts)
  await run(imageRequest(image, overrides))
  return requests[0]!.body as Record<string, unknown>
}

async function runImage(status: number, body: unknown, image: ImageOptions = {}) {
  installFetch(() => jsonResponse(status, body))
  const run = await complete()
  return run(imageRequest(image))
}

function isKind(kind: string) {
  return (error: unknown) => ProviderError.is(error) && error.kind === kind
}

function expectMalformed(body: unknown): Promise<void> {
  return expect(runImage(200, body)).rejects.toSatisfy(
    isKind('malformed_response'),
  ) as Promise<void>
}

describe('the factory', () => {
  it.each([
    ['the default base', undefined, 'https://api.openai.com/v1/images/generations'],
    ['a custom base', 'https://example.com/v1', 'https://example.com/v1/images/generations'],
    [
      'a custom base with a trailing slash',
      'https://example.com/v1/',
      'https://example.com/v1/images/generations',
    ],
    [
      'a custom base with several trailing slashes',
      'https://example.com/v1//',
      'https://example.com/v1/images/generations',
    ],
  ])('posts to %s', async (_label, baseUrl, expected) => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete(baseUrl === undefined ? {} : { baseUrl })
    await run(imageRequest())
    expect(requests[0]!.url).toBe(expected)
    expect(requests[0]!.method).toBe('POST')
  })

  it('sends a Bearer authorization header built from the resolved key, and a JSON body', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    await run(imageRequest())
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-images-test')
    expect(requests[0]!.headers['content-type']).toBe('application/json')
  })

  it('resolves the key in prepare(), from a sync or an async resolver', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete({ apiKey: () => Promise.resolve('sk-async') })
    await run(imageRequest())
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-async')
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('rejects prepare() for an %s key', async (_label, key) => {
    const provider = openaiImages({ apiKey: () => key })
    await expect(provider.prepare!()).rejects.toThrow('missing api key')
  })

  it('refuses complete() without prepare() as auth, without touching fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const provider = openaiImages({ apiKey: KEY })
    // Whether it throws or rejects, the caller sees the same failure.
    const error: unknown = await Promise.resolve()
      .then(() => provider.complete(imageRequest()))
      .then(
        () => null,
        (thrown: unknown) => thrown,
      )
    expect(ProviderError.is(error) && error.kind === 'auth').toBe(true)
    expect((error as Error).message).toBe('prepare required')
    expect(requests).toHaveLength(0)
  })

  it("always fetches with redirect: 'error'", async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    await run(imageRequest())
    expect(requests[0]!.redirect).toBe('error')
  })

  it('passes the exact request signal through to fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    const req = imageRequest()
    await run(req)
    expect(requests[0]!.signal).toBe(req.signal)
  })
})

describe('the gates', () => {
  const PDF: ContentPart = { type: 'file', mediaType: 'application/pdf', data: 'AAAA' }
  const PICTURE: ContentPart = { type: 'file', mediaType: 'image/png', data: PNG_DATA }

  async function expectGate(req: ProviderRequest, message: string): Promise<void> {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    const error: unknown = await run(req).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error) && error.kind === 'invalid_request').toBe(true)
    expect((error as Error).message).toBe(message)
    expect(requests).toHaveLength(0)
  }

  it.each([
    ['text', { type: 'text' } as const],
    ['json object', { type: 'json', topLevel: 'object' } as const],
    ['json any', { type: 'json', topLevel: 'any' } as const],
  ])('rejects a %s request', async (_label, responseFormat) => {
    await expectGate(baseRequest({ responseFormat }), 'only image output is supported')
  })

  it.each([
    ['a PDF part', [{ type: 'text', text: 'draw it' }, PDF]],
    ['an image part', [{ type: 'text', text: 'draw it like this' }, PICTURE]],
    ['a lone image part', [PICTURE]],
  ] as const)('rejects a request carrying %s', async (_label, parts) => {
    await expectGate(imageRequest({}, { parts }), 'file parts are not supported')
  })

  it.each([
    ['aspectRatio alone', { aspectRatio: '16:9' } as const],
    ['size alone', { size: '1K' } as const],
  ])('rejects %s', async (_label, image) => {
    await expectGate(imageRequest(image), 'aspectRatio and size must be set together')
  })

  it.each(['1:1', '3:2', '2:3', '9:16', '4:3', '3:4'] as const)(
    "rejects size '4K' at %s",
    async (aspectRatio) => {
      await expectGate(
        imageRequest({ size: '4K', aspectRatio }),
        "size '4K' needs aspectRatio '16:9'",
      )
    },
  )

  it("passes size '4K' at 16:9", async () => {
    const body = await sentBody({ size: '4K', aspectRatio: '16:9' })
    expect(body.size).toBe('3840x2160')
  })

  // Outside the typed knobs, which the core validates, a value has no table cell: it is
  // rejected rather than sent, and an inherited property never stands in for one.
  it.each([
    ['an unknown class', { size: '8K', aspectRatio: '1:1' }],
    ['an unknown ratio', { size: '1K', aspectRatio: '5:4' }],
    ['an inherited class name', { size: 'toString', aspectRatio: '1:1' }],
    ['an inherited ratio name', { size: '2K', aspectRatio: 'constructor' }],
  ])('rejects %s', async (_label, image) => {
    await expectGate(
      imageRequest(image as unknown as ImageOptions),
      'unsupported size or aspect ratio',
    )
  })

  it('checks the format before the parts, the parts before the pair, the pair before 4K', async () => {
    await expectGate(
      baseRequest({ parts: [PDF], responseFormat: { type: 'text' } }),
      'only image output is supported',
    )
    await expectGate(
      imageRequest({ aspectRatio: '1:1' }, { parts: [PDF] }),
      'file parts are not supported',
    )
    await expectGate(imageRequest({ size: '4K' }), 'aspectRatio and size must be set together')
  })
})

describe('the prompt', () => {
  it('sends one text part verbatim', async () => {
    const body = await sentBody({}, {}, { parts: textParts('  a fox\n in snow ') })
    expect(body.prompt).toBe('  a fox\n in snow ')
  })

  it("sends an empty text part as ''", async () => {
    const body = await sentBody({}, {}, { parts: textParts('') })
    expect(body.prompt).toBe('')
  })

  it('joins several text parts with a newline, empty ones included', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'a fox' },
      { type: 'text', text: '' },
      { type: 'text', text: 'in snow' },
    ]
    const body = await sentBody({}, {}, { parts })
    expect(body.prompt).toBe('a fox\n\nin snow')
  })
})

describe('the body', () => {
  it('sends exactly model and prompt when no knob is set', async () => {
    const body = await sentBody({}, {}, { model: 'gpt-image-x' })
    expect(Object.keys(body).sort()).toEqual(['model', 'prompt'])
    expect(body).toEqual({ model: 'gpt-image-x', prompt: 'hello' })
  })

  it('sends count alone as n', async () => {
    expect(await sentBody({ count: 3 })).toEqual({ model: 'test-model', prompt: 'hello', n: 3 })
  })

  it.each(['transparent', 'opaque'] as const)(
    'sends background %s verbatim',
    async (background) => {
      expect(await sentBody({ background })).toEqual({
        model: 'test-model',
        prompt: 'hello',
        background,
      })
    },
  )

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends the factory quality %s verbatim',
    async (quality) => {
      expect(await sentBody({}, { quality })).toEqual({
        model: 'test-model',
        prompt: 'hello',
        quality,
      })
    },
  )

  it('sends every field together', async () => {
    const body = await sentBody(
      { count: 2, aspectRatio: '16:9', size: '2K', background: 'opaque' },
      { quality: 'low' },
    )
    expect(body).toEqual({
      model: 'test-model',
      prompt: 'hello',
      n: 2,
      size: '2048x1152',
      background: 'opaque',
      quality: 'low',
    })
  })

  it('drops maxOutputTokens and temperature, which have no field on this wire', async () => {
    const body = await sentBody({}, {}, { maxOutputTokens: 256, temperature: 0.5 })
    expect(body).toEqual({ model: 'test-model', prompt: 'hello' })
  })

  it('never sends output_format, moderation or response_format', async () => {
    const body = await sentBody(
      { count: 1, aspectRatio: '1:1', size: '1K', background: 'transparent' },
      { quality: 'high' },
    )
    for (const field of ['output_format', 'moderation', 'response_format', 'max_tokens']) {
      expect(body).not.toHaveProperty(field)
    }
  })
})

describe('the size table', () => {
  const CELLS: readonly (readonly [ImageSize, AspectRatio, string])[] = [
    ['1K', '1:1', '1024x1024'],
    ['1K', '3:2', '1536x1024'],
    ['1K', '2:3', '1024x1536'],
    ['1K', '16:9', '1536x864'],
    ['1K', '9:16', '864x1536'],
    ['1K', '4:3', '1024x768'],
    ['1K', '3:4', '768x1024'],
    ['2K', '1:1', '2048x2048'],
    ['2K', '3:2', '2016x1344'],
    ['2K', '2:3', '1344x2016'],
    ['2K', '16:9', '2048x1152'],
    ['2K', '9:16', '1152x2048'],
    ['2K', '4:3', '2048x1536'],
    ['2K', '3:4', '1536x2048'],
    ['4K', '16:9', '3840x2160'],
  ]

  it('holds fifteen cells', () => {
    expect(CELLS).toHaveLength(15)
  })

  it.each(CELLS)('sends %s at %s as %s', async (size, aspectRatio, wire) => {
    const body = await sentBody({ size, aspectRatio })
    expect(body.size).toBe(wire)

    const [width, height] = wire.split('x').map(Number) as [number, number]
    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number) as [number, number]
    expect(width * ratioHeight).toBe(height * ratioWidth)
    expect(width % 16).toBe(0)
    expect(height % 16).toBe(0)
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3)
  })
})

describe('the response', () => {
  it('reads one image, leaving the dimensions to the core, with empty text', async () => {
    const response = await runImage(200, imagesBody())
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: null,
    })
  })

  it('keeps the order of several images', async () => {
    const second = base64(png(4, 5))
    const third = base64(png(6, 7))
    const response = await runImage(
      200,
      imagesBody({}, [{ b64_json: PNG_DATA }, { b64_json: second }, { b64_json: third }]),
    )
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA },
      { mediaType: 'image/png', data: second },
      { mediaType: 'image/png', data: third },
    ])
  })

  it('answers complete with no images for an empty data array', async () => {
    const response = await runImage(200, imagesBody({}, []))
    expect(response).toEqual({ kind: 'complete', text: '', images: [], usage: null })
  })

  it('ignores the fields it does not read', async () => {
    const response = await runImage(
      200,
      imagesBody({ background: 'opaque', quality: 'high' }, [
        { b64_json: PNG_DATA, revised_prompt: 'a fox, in snow', url: 'https://example.com/x' },
      ]),
    )
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: null,
    })
  })

  it.each([
    ['data is absent', { created: 1 }],
    ['data is not an array', { data: { 0: { b64_json: PNG_DATA } } }],
    ['data is null', { data: null }],
    ['an element is not a record', imagesBody({}, ['AAAA'])],
    ['an element is null', imagesBody({}, [{ b64_json: PNG_DATA }, null])],
    ['an element is an array', imagesBody({}, [[PNG_DATA]])],
    ['b64_json is absent', imagesBody({}, [{ url: 'https://example.com/x' }])],
    ['b64_json is not a string', imagesBody({}, [{ b64_json: 1 }])],
    ['b64_json is null', imagesBody({}, [{ b64_json: null }])],
    ['b64_json fails the grammar', imagesBody({}, [{ b64_json: 'AAA' }])],
    ['b64_json is empty', imagesBody({}, [{ b64_json: '' }])],
    [
      'b64_json carries a data-URL prefix',
      imagesBody({}, [{ b64_json: `data:image/png;base64,${PNG_DATA}` }]),
    ],
    ['a later element fails', imagesBody({}, [{ b64_json: PNG_DATA }, { b64_json: 'AA A' }])],
  ])('throws malformed_response when %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it.each([
    ['null (an empty body)', null],
    ['an array', [{ b64_json: PNG_DATA }]],
    ['a string', 'ok'],
    ['a number', 1],
  ])('throws malformed_response for a 2xx body that is %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it.each([
    ['absent', undefined, 'image/png'],
    ["'png'", 'png', 'image/png'],
    ["'jpeg'", 'jpeg', 'image/jpeg'],
    ["'webp'", 'webp', 'image/webp'],
  ])('maps an output_format that is %s', async (_label, outputFormat, mediaType) => {
    const extra = outputFormat === undefined ? {} : { output_format: outputFormat }
    const response = await runImage(200, imagesBody(extra))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType, data: PNG_DATA },
    ])
  })

  it.each([
    ["'gif'", 'gif'],
    ["'PNG'", 'PNG'],
    ["'image/png'", 'image/png'],
    ['a number', 1],
    ['null', null],
  ])('throws malformed_response for an output_format of %s', async (_label, outputFormat) => {
    await expectMalformed(imagesBody({ output_format: outputFormat }))
  })

  it('reads an unknown output_format before the elements, even with no image', async () => {
    await expectMalformed(imagesBody({ output_format: 'gif' }, []))
  })

  it('states the response size on every image', async () => {
    const response = await runImage(
      200,
      imagesBody({ size: '1024x1024' }, [{ b64_json: PNG_DATA }, { b64_json: PNG_DATA }]),
    )
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA, width: 1024, height: 1024 },
      { mediaType: 'image/png', data: PNG_DATA, width: 1024, height: 1024 },
    ])
  })

  it('reads a size that is not square in width-by-height order', async () => {
    const response = await runImage(200, imagesBody({ size: '1536x864' }))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA, width: 1536, height: 864 },
    ])
  })

  it.each([
    ['absent', undefined],
    ["'auto'", 'auto'],
    ["'1024x'", '1024x'],
    ["'x1024'", 'x1024'],
    ["'0x1024'", '0x1024'],
    ["'1024x0'", '1024x0'],
    ["'1024X1024'", '1024X1024'],
    ["' 1024x1024'", ' 1024x1024'],
    ["'1024x1024 '", '1024x1024 '],
    ["'1024x1024x3'", '1024x1024x3'],
    ["'-1024x1024'", '-1024x1024'],
    ["'1024.5x1024'", '1024.5x1024'],
    ['past the safe integers', '9007199254740993x1024'],
    ['a number', 1024],
    ['null', null],
    ['an object', { width: 1024, height: 1024 }],
  ])('states no dimensions for a size that is %s', async (_label, size) => {
    const extra = size === undefined ? {} : { size }
    const response = await runImage(200, imagesBody(extra))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA },
    ])
    const image = response.kind === 'complete' ? response.images?.[0] : undefined
    expect(image).not.toHaveProperty('width')
    expect(image).not.toHaveProperty('height')
  })
})

describe('the response caps', () => {
  // The adapter states the §3 point 4b caps on its own side: the core would reject the same
  // response, but only after the grammar had run over every oversized string in it.
  const OVERSIZED = 'A'.repeat(30_000_004)
  const AT_CAP = 'A'.repeat(30_000_000)

  function elements(count: number) {
    return Array.from({ length: count }, () => ({ b64_json: PNG_DATA }))
  }

  it('reads thirty-two images', async () => {
    const response = await runImage(200, imagesBody({}, elements(32)))
    expect(response.kind === 'complete' && response.images).toHaveLength(32)
  })

  it('throws malformed_response on the thirty-third image, before its grammar scan', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imagesBody({}, elements(33)))
    expect(isWireBase64).toHaveBeenCalledTimes(32)
  })

  it('reads an image whose data is exactly the per-image cap', async () => {
    const response = await runImage(200, imagesBody({}, [{ b64_json: AT_CAP }]))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: AT_CAP },
    ])
  })

  it('throws malformed_response on over-long data, without running the grammar', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imagesBody({}, [{ b64_json: OVERSIZED }]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })
})

describe('refusal', () => {
  it.each([
    [
      'moderation_blocked at 400',
      400,
      { error: { code: 'moderation_blocked', type: 'image_generation_user_error' } },
    ],
    ['moderation_blocked alone', 400, { error: { code: 'moderation_blocked' } }],
    [
      'image_generation_user_error at 400',
      400,
      { error: { type: 'image_generation_user_error' } },
    ],
    [
      'image_generation_user_error at 403',
      403,
      { error: { type: 'image_generation_user_error' } },
    ],
    [
      'image_generation_user_error at 500',
      500,
      { error: { type: 'image_generation_user_error' } },
    ],
    ['content_policy_violation at 400', 400, { error: { code: 'content_policy_violation' } }],
    [
      'moderation_blocked on a 2xx body beside data',
      200,
      { error: { code: 'moderation_blocked' }, data: [{ b64_json: PNG_DATA }] },
    ],
  ])('returns refused with null usage for %s', async (_label, status, body) => {
    const response = await runImage(status, {
      ...body,
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null })
  })

  it.each([
    ['an unrelated code', { error: { code: 'invalid_value', type: 'invalid_request_error' } }],
    ['an error that is not a record', { error: 'moderation_blocked' }],
    ['the code outside error', { code: 'moderation_blocked' }],
  ])('classifies a 400 with %s as invalid_request', async (_label, body) => {
    await expect(runImage(400, body)).rejects.toSatisfy(isKind('invalid_request'))
  })
})

describe('error classification', () => {
  it.each([
    ['401 -> auth', 401, {}, 'auth'],
    ['403 -> auth', 403, {}, 'auth'],
    ['404 -> model_not_found', 404, {}, 'model_not_found'],
    ['429 -> rate_limit', 429, {}, 'rate_limit'],
    ['402 -> rate_limit', 402, {}, 'rate_limit'],
    ['500 -> transient', 500, {}, 'transient'],
    ['498 -> transient', 498, {}, 'transient'],
    ['400 -> invalid_request', 400, {}, 'invalid_request'],
    [
      '422 with a model_not_found code -> model_not_found',
      422,
      { error: { code: 'model_not_found' } },
      'model_not_found',
    ],
    ['an unparseable 502 -> transient', 502, null, 'transient'],
  ])('%s', async (_label, status, body, expectedKind) => {
    const error: unknown = await runImage(status, body).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error) && error.kind === expectedKind).toBe(true)
    expect((error as ProviderError).status).toBe(status)
  })

  it('has no OpenRouter branch: a 403 moderation envelope stays auth', async () => {
    installFetch(() => jsonResponse(403, { error: { type: 'moderation' } }))
    const run = await complete({ baseUrl: 'https://openrouter.ai/api/v1' })
    await expect(run(imageRequest())).rejects.toSatisfy(isKind('auth'))
  })

  it('classifies an abort-triggered fetch rejection as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    installFetch(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    await expect(run(imageRequest({}, { signal: controller.signal }))).rejects.toSatisfy(
      isKind('aborted'),
    )
  })

  it('classifies a plain network failure (no abort) as transient', async () => {
    installFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const run = await complete()
    await expect(run(imageRequest())).rejects.toSatisfy(isKind('transient'))
  })

  it.each([
    ['an error body', 400, { error: { message: `bad: ${SENTINEL}` } }],
    ['a malformed image', 200, imagesBody({}, [{ b64_json: `${SENTINEL}=` }])],
  ])('never embeds the payload of %s in a thrown message', async (_label, status, body) => {
    installFetch(() => jsonResponse(status, body))
    const run = await complete()
    const error: unknown = await run(imageRequest({}, { parts: textParts(SENTINEL) })).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error)).toBe(true)
    expect((error as Error).message).not.toContain(SENTINEL)
  })
})

describe('usage', () => {
  async function usageFor(usage: unknown) {
    const extra = usage === undefined ? {} : { usage }
    const response = await runImage(200, imagesBody(extra))
    return response.usage
  }

  it('reads the base counters', async () => {
    const usage = await usageFor({ input_tokens: 10, output_tokens: 1200, total_tokens: 1210 })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(usage).not.toHaveProperty('imageOutputTokens')
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not a record', 'usage'],
    ['an array', [10, 1200]],
  ])('is null when the envelope is %s', async (_label, usage) => {
    expect(await usageFor(usage)).toBeNull()
  })

  it.each([
    ['input_tokens is absent', { output_tokens: 1200 }],
    ['output_tokens is absent', { input_tokens: 10 }],
    ['input_tokens is a string', { input_tokens: '10', output_tokens: 1200 }],
    ['output_tokens is negative', { input_tokens: 10, output_tokens: -1 }],
    ['input_tokens is fractional', { input_tokens: 10.5, output_tokens: 1200 }],
    [
      'the base counters are invalid beside a valid split',
      { input_tokens: 10, output_tokens: -1, output_tokens_details: { image_tokens: 0 } },
    ],
  ])('is null when %s', async (_label, usage) => {
    expect(await usageFor(usage)).toBeNull()
  })

  it('reads output_tokens_details.image_tokens into imageOutputTokens', async () => {
    const usage = await usageFor({
      input_tokens: 10,
      output_tokens: 1200,
      output_tokens_details: { image_tokens: 1100, text_tokens: 100 },
    })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200, imageOutputTokens: 1100 })
  })

  it('accepts an image share equal to the output tokens', async () => {
    const usage = await usageFor({
      input_tokens: 10,
      output_tokens: 1200,
      output_tokens_details: { image_tokens: 1200 },
    })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200, imageOutputTokens: 1200 })
  })

  it.each([
    ['details are absent', undefined],
    ['details are null', null],
    ['details are not a record', 'details'],
    ['details are an array', [{ image_tokens: 1100 }]],
    ['image_tokens is absent', { text_tokens: 100 }],
    ['image_tokens is negative', { image_tokens: -1 }],
    ['image_tokens is fractional', { image_tokens: 1.5 }],
    ['image_tokens is a string', { image_tokens: '1100' }],
    ['image_tokens is null', { image_tokens: null }],
    ['image_tokens is past the safe integers', { image_tokens: 2 ** 53 }],
    ['image_tokens is above the output tokens', { image_tokens: 1201 }],
  ])('omits imageOutputTokens when %s, keeping the base counters', async (_label, details) => {
    const raw: Record<string, unknown> = { input_tokens: 10, output_tokens: 1200 }
    if (details !== undefined) raw.output_tokens_details = details
    const usage = await usageFor(raw)
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(usage).not.toHaveProperty('imageOutputTokens')
  })

  it('keeps usage on a complete answer with no images', async () => {
    const response = await runImage(
      200,
      imagesBody({ usage: { input_tokens: 10, output_tokens: 0 } }, []),
    )
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [],
      usage: { inputTokens: 10, outputTokens: 0 },
    })
  })
})
