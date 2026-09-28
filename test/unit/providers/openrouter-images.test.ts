import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { openrouterImages } from '../../../src/providers/openrouter-images'
import { isWireBase64 } from '../../../src/providers/transport'
import type * as transportModule from '../../../src/providers/transport'
import type { ContentPart, ImageOptions, ProviderRequest } from '../../../src/types'
import { base64, jpeg, png, webpVP8L } from '../core/image-fixtures'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  SENTINEL,
  textParts,
  withPrepared,
} from './helpers'
import {
  AUTH_WORDS,
  ERROR_TYPE_LOCATIONS,
  MODERATION_METADATA_BODY,
  MODERATION_WORDS,
  OTHER_WORDS,
  RATE_LIMIT_WORDS,
  typedErrorBody,
} from './openrouter-fixtures'

// The module keeps its real behaviour; the wrapper only makes the grammar scan observable,
// so the cap tests can show what the adapter never reaches. Vitest hoists this above the
// imports above.
vi.mock('../../../src/providers/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof transportModule>()
  return { ...actual, isWireBase64: vi.fn(actual.isWireBase64) }
})

const KEY = () => 'sk-or-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Options = Parameters<typeof openrouterImages>[0]

async function complete(opts: Partial<Options> = {}) {
  return withPrepared(openrouterImages({ apiKey: KEY, ...opts }))
}

const PNG_DATA = base64(png(2, 3))

function imageRequest(image: ImageOptions = {}, overrides: Partial<ProviderRequest> = {}) {
  return baseRequest({ responseFormat: { type: 'image', ...image }, ...overrides })
}

/** One `data[]` element as the Image API answers it: base64 with its media type. */
function element(data: string = PNG_DATA, mediaType: unknown = 'image/png') {
  return { b64_json: data, media_type: mediaType }
}

/** An Image API answer: the `data` array, plus any top-level fields. */
function imagesBody(extra: Record<string, unknown> = {}, data: unknown[] = [element()]) {
  return { data, ...extra }
}

/** The body the adapter sent for one image request, answered with one image. */
async function sentBody(
  image: ImageOptions = {},
  overrides: Partial<ProviderRequest> = {},
): Promise<Record<string, unknown>> {
  const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
  const run = await complete()
  await run(imageRequest(image, overrides))
  return requests[0]!.body as Record<string, unknown>
}

async function runImage(status: number, body: unknown, opts: Partial<Options> = {}) {
  installFetch(() => jsonResponse(status, body))
  const run = await complete(opts)
  return run(imageRequest())
}

/** Answers with body text written by hand, for values `JSON.stringify` cannot write. */
async function runRaw(raw: string) {
  installFetch(
    () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  const run = await complete()
  return run(imageRequest())
}

function isKind(kind: string) {
  return (error: unknown) => ProviderError.is(error) && error.kind === kind
}

function expectMalformed(body: unknown): Promise<void> {
  return expect(runImage(200, body)).rejects.toSatisfy(
    isKind('malformed_response'),
  ) as Promise<void>
}

/** The thrown value of a run, or `null` when it resolved. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (thrown: unknown) => thrown,
  )
}

describe('the factory', () => {
  it.each([
    ['the default base', undefined, 'https://openrouter.ai/api/v1/images'],
    ['a custom base', 'https://example.com/v1', 'https://example.com/v1/images'],
    [
      'a custom base with a trailing slash',
      'https://example.com/v1/',
      'https://example.com/v1/images',
    ],
    [
      'a custom base with several trailing slashes',
      'https://example.com/v1//',
      'https://example.com/v1/images',
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
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-or-test')
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
    const provider = openrouterImages({ apiKey: () => key })
    await expect(provider.prepare!()).rejects.toThrow('missing api key')
  })

  it('refuses complete() without prepare() as auth, without touching fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const provider = openrouterImages({ apiKey: KEY })
    // Whether it throws or rejects, the caller sees the same failure.
    const error = await failureOf(
      Promise.resolve().then(() => provider.complete(imageRequest())),
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
    const error = await failureOf(run(req))
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

  it('checks the format before the parts', async () => {
    await expectGate(
      baseRequest({ parts: [PDF], responseFormat: { type: 'text' } }),
      'only image output is supported',
    )
  })

  // Each knob travels in its own field on this wire, so no combination of them is gated:
  // a model that lacks one answers its own error.
  it.each([
    ['aspectRatio alone', { aspectRatio: '16:9' } as const],
    ['size alone', { size: '1K' } as const],
    ["size '4K' at 1:1", { size: '4K', aspectRatio: '1:1' } as const],
    ["size '4K' at 3:4", { size: '4K', aspectRatio: '3:4' } as const],
  ])('passes %s to the wire', async (_label, image) => {
    const { requests } = captureRequests(() => jsonResponse(200, imagesBody()))
    const run = await complete()
    await run(imageRequest(image))
    expect(requests).toHaveLength(1)
  })
})

describe('the prompt', () => {
  it('sends one text part verbatim', async () => {
    const body = await sentBody({}, { parts: textParts('  a fox\n in snow ') })
    expect(body.prompt).toBe('  a fox\n in snow ')
  })

  it("sends an empty text part as ''", async () => {
    const body = await sentBody({}, { parts: textParts('') })
    expect(body.prompt).toBe('')
  })

  it('joins several text parts with a newline, empty ones included', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'a fox' },
      { type: 'text', text: '' },
      { type: 'text', text: 'in snow' },
    ]
    const body = await sentBody({}, { parts })
    expect(body.prompt).toBe('a fox\n\nin snow')
  })
})

describe('the body', () => {
  const BASE = { model: 'test-model', prompt: 'hello' }

  it('sends exactly model and prompt when no knob is set', async () => {
    const body = await sentBody({}, { model: 'bytedance-seed/seedream-x' })
    expect(Object.keys(body).sort()).toEqual(['model', 'prompt'])
    expect(body).toEqual({ model: 'bytedance-seed/seedream-x', prompt: 'hello' })
  })

  it('sends count alone as n', async () => {
    expect(await sentBody({ count: 3 })).toEqual({ ...BASE, n: 3 })
  })

  it.each(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const)(
    'sends aspectRatio %s alone, verbatim, as aspect_ratio',
    async (aspectRatio) => {
      expect(await sentBody({ aspectRatio })).toEqual({ ...BASE, aspect_ratio: aspectRatio })
    },
  )

  it.each(['1K', '2K', '4K'] as const)(
    'sends size %s alone, verbatim, as resolution',
    async (size) => {
      expect(await sentBody({ size })).toEqual({ ...BASE, resolution: size })
    },
  )

  it.each(['transparent', 'opaque'] as const)(
    'sends background %s alone, verbatim',
    async (background) => {
      expect(await sentBody({ background })).toEqual({ ...BASE, background })
    },
  )

  it('sends every knob together, each in its own field', async () => {
    const body = await sentBody({
      count: 2,
      aspectRatio: '3:2',
      size: '2K',
      background: 'transparent',
    })
    expect(body).toEqual({
      ...BASE,
      n: 2,
      aspect_ratio: '3:2',
      resolution: '2K',
      background: 'transparent',
    })
  })

  it('drops maxOutputTokens and temperature, which have no field on this wire', async () => {
    const body = await sentBody({}, { maxOutputTokens: 256, temperature: 0.5 })
    expect(body).toEqual(BASE)
  })

  it('never sends a field outside the knobs', async () => {
    const body = await sentBody(
      { count: 1, aspectRatio: '1:1', size: '1K', background: 'opaque' },
      { maxOutputTokens: 256, temperature: 0.5 },
    )
    for (const field of [
      'quality',
      'output_format',
      'seed',
      'stream',
      'provider',
      'max_tokens',
      'temperature',
      'size',
      'response_format',
    ]) {
      expect(body).not.toHaveProperty(field)
    }
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
    expect(response).not.toHaveProperty('costUsd')
  })

  it('keeps the order of several images', async () => {
    const second = base64(png(4, 5))
    const third = base64(png(6, 7))
    const response = await runImage(
      200,
      imagesBody({}, [element(), element(second), element(third)]),
    )
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA },
      { mediaType: 'image/png', data: second },
      { mediaType: 'image/png', data: third },
    ])
  })

  it.each([
    ['image/png', PNG_DATA],
    ['image/jpeg', base64(jpeg(2, 3))],
    ['image/webp', base64(webpVP8L(2, 3))],
  ])('reads a media_type of %s', async (mediaType, data) => {
    const response = await runImage(200, imagesBody({}, [element(data, mediaType)]))
    expect(response.kind === 'complete' && response.images).toEqual([{ mediaType, data }])
  })

  it('reads a different media type on each image', async () => {
    const jpegData = base64(jpeg(2, 3))
    const response = await runImage(
      200,
      imagesBody({}, [element(jpegData, 'image/jpeg'), element(PNG_DATA, 'image/png')]),
    )
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/jpeg', data: jpegData },
      { mediaType: 'image/png', data: PNG_DATA },
    ])
  })

  it('states no dimensions on any image, whatever the body says', async () => {
    const response = await runImage(
      200,
      imagesBody({ size: '1024x1024', width: 1024, height: 1024 }, [
        { ...element(), width: 1024, height: 1024 },
        element(),
      ]),
    )
    const images = response.kind === 'complete' ? (response.images ?? []) : []
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image).not.toHaveProperty('width')
      expect(image).not.toHaveProperty('height')
    }
  })

  it('answers complete with no images for an empty data array', async () => {
    const response = await runImage(200, imagesBody({}, []))
    expect(response).toEqual({ kind: 'complete', text: '', images: [], usage: null })
  })

  it('ignores the fields it does not read', async () => {
    const response = await runImage(
      200,
      imagesBody({ created: 1, model: 'x', id: 'gen-1' }, [
        { ...element(), revised_prompt: 'a fox, in snow', url: 'https://example.com/x' },
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
    ['image/svg+xml, from a vector model', 'image/svg+xml'],
    ['absent', undefined],
    ['null', null],
    ['image/gif', 'image/gif'],
    ['upper case', 'IMAGE/PNG'],
    ['a bare format name', 'png'],
    ['an empty string', ''],
    ['a number', 1],
    ['an object', { type: 'image/png' }],
  ])('throws malformed_response for a media_type that is %s', async (_label, mediaType) => {
    const bad = mediaType === undefined ? { b64_json: PNG_DATA } : element(PNG_DATA, mediaType)
    await expectMalformed(imagesBody({}, [bad]))
  })

  it('throws malformed_response for an SVG after a good image', async () => {
    await expectMalformed(imagesBody({}, [element(), element(PNG_DATA, 'image/svg+xml')]))
  })

  it('reads the media type before running the grammar', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imagesBody({}, [element('PHN2Zz4=', 'image/svg+xml')]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })

  it.each([
    ['data is absent', { usage: { prompt_tokens: 1, completion_tokens: 1 } }],
    ['data is not an array', { data: { 0: element() } }],
    ['data is null', { data: null }],
    ['data is a string', { data: PNG_DATA }],
    ['an element is not a record', imagesBody({}, ['AAAA'])],
    ['an element is null', imagesBody({}, [element(), null])],
    ['an element is an array', imagesBody({}, [[PNG_DATA]])],
    ['b64_json is absent', imagesBody({}, [{ media_type: 'image/png' }])],
    [
      'b64_json is absent beside a url',
      imagesBody({}, [{ url: 'https://example.com/x', media_type: 'image/png' }]),
    ],
    ['b64_json is not a string', imagesBody({}, [{ b64_json: 1, media_type: 'image/png' }])],
    ['b64_json is null', imagesBody({}, [{ b64_json: null, media_type: 'image/png' }])],
    ['b64_json fails the grammar', imagesBody({}, [element('AAA')])],
    ['b64_json is empty', imagesBody({}, [element('')])],
    [
      'b64_json carries a data-URL prefix',
      imagesBody({}, [element(`data:image/png;base64,${PNG_DATA}`)]),
    ],
    ['a later element fails the grammar', imagesBody({}, [element(), element('AA A')])],
  ])('throws malformed_response when %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it.each([
    ['null (an empty body)', null],
    ['an array', [element()]],
    ['a string', 'ok'],
    ['a number', 1],
  ])('throws malformed_response for a 2xx body that is %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it('throws malformed_response with the HTTP status', async () => {
    const error = await failureOf(runImage(201, { data: 'x' }))
    expect(ProviderError.is(error) && error.kind === 'malformed_response').toBe(true)
    expect((error as ProviderError).status).toBe(201)
  })
})

describe('the response caps', () => {
  // The adapter states the §3 point 4b caps on its own side: the core would reject the same
  // response, but only after the grammar had run over every oversized string in it.
  const OVERSIZED = 'A'.repeat(30_000_004)
  const AT_CAP = 'A'.repeat(30_000_000)

  function elements(count: number) {
    return Array.from({ length: count }, () => element())
  }

  it('reads thirty-two images', async () => {
    vi.mocked(isWireBase64).mockClear()
    const response = await runImage(200, imagesBody({}, elements(32)))
    expect(response.kind === 'complete' && response.images).toHaveLength(32)
    expect(isWireBase64).toHaveBeenCalledTimes(32)
  })

  it('throws malformed_response for thirty-three images, before reading any of them', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imagesBody({}, elements(33)))
    expect(isWireBase64).not.toHaveBeenCalled()
  })

  it('reads an image whose data is exactly the per-image cap', async () => {
    const response = await runImage(200, imagesBody({}, [element(AT_CAP)]))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: AT_CAP },
    ])
  })

  it('throws malformed_response on over-long data, without running the grammar', async () => {
    // Grammatical, so only the cap can reject it.
    expect(OVERSIZED.length % 4).toBe(0)
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imagesBody({}, [element(OVERSIZED)]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })
})

describe('reported cost', () => {
  const COUNTS = { prompt_tokens: 10, completion_tokens: 1200 }
  const USAGE = { inputTokens: 10, outputTokens: 1200 }

  async function responseFor(usage: unknown) {
    return runImage(200, imagesBody(usage === undefined ? {} : { usage }))
  }

  it.each([
    ['a typical charge', 0.0406],
    ['zero', 0],
    ['a fractional cent', 0.000_125],
    ['a whole number', 2],
  ])('carries usage.cost as costUsd for %s', async (_label, cost) => {
    const response = await responseFor({ ...COUNTS, cost })
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: USAGE,
      costUsd: cost,
    })
  })

  it.each([
    ['absent', undefined],
    ['negative', -0.01],
    ['a string', '0.04'],
    ['null', null],
    ['a boolean', true],
    ['an object', { total: 0.04 }],
  ])('leaves costUsd out, not undefined, when usage.cost is %s', async (_label, cost) => {
    const usage: Record<string, unknown> = { ...COUNTS }
    if (cost !== undefined) usage.cost = cost
    const response = await responseFor(usage)
    expect(response.usage).toEqual(USAGE)
    expect(Object.hasOwn(response, 'costUsd')).toBe(false)
  })

  it('leaves costUsd out when the usage envelope is absent or not a record', async () => {
    for (const usage of [undefined, null, 'usage', [COUNTS]]) {
      const response = await responseFor(usage)
      expect(response.usage).toBeNull()
      expect(Object.hasOwn(response, 'costUsd')).toBe(false)
    }
  })

  it('leaves costUsd out when a cost of 1e400 reads as Infinity', async () => {
    const response = await runRaw(
      `{"data":[{"b64_json":"${PNG_DATA}","media_type":"image/png"}],` +
        '"usage":{"prompt_tokens":10,"completion_tokens":1200,"cost":1e400}}',
    )
    expect(response.usage).toEqual(USAGE)
    expect(Object.hasOwn(response, 'costUsd')).toBe(false)
  })

  // `JSON.stringify` writes `-0` as `0`, so the only way to put one on the wire is to script
  // the body text; `JSON.parse` reads it back as `-0`.
  it('reads a cost of -0 as an unsigned 0', async () => {
    const response = await runRaw(
      `{"data":[{"b64_json":"${PNG_DATA}","media_type":"image/png"}],` +
        '"usage":{"prompt_tokens":10,"completion_tokens":1200,"cost":-0}}',
    )
    expect(response.costUsd).toBe(0)
    expect(Object.is(response.costUsd, 0)).toBe(true)
  })

  it('carries the cost when the counters are invalid and usage is null', async () => {
    const response = await responseFor({
      prompt_tokens: -1,
      completion_tokens: 1200,
      cost: 0.04,
    })
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: null,
      costUsd: 0.04,
    })
  })

  it('carries the cost on a complete answer with no images', async () => {
    const response = await runImage(200, imagesBody({ usage: { ...COUNTS, cost: 0.04 } }, []))
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [],
      usage: USAGE,
      costUsd: 0.04,
    })
  })
})

describe('usage', () => {
  async function usageFor(usage: unknown) {
    const response = await runImage(200, imagesBody(usage === undefined ? {} : { usage }))
    return response.usage
  }

  it('reads the base counters', async () => {
    const usage = await usageFor({
      prompt_tokens: 10,
      completion_tokens: 1200,
      total_tokens: 1210,
    })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
  })

  it('never reports imageOutputTokens, even beside a breakdown', async () => {
    const usage = await usageFor({
      prompt_tokens: 10,
      completion_tokens: 1200,
      completion_tokens_details: { image_tokens: 1100 },
      output_tokens_details: { image_tokens: 1100 },
    })
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
    ['prompt_tokens is absent', { completion_tokens: 1200 }],
    ['completion_tokens is absent', { prompt_tokens: 10 }],
    ['prompt_tokens is a string', { prompt_tokens: '10', completion_tokens: 1200 }],
    ['completion_tokens is negative', { prompt_tokens: 10, completion_tokens: -1 }],
    ['prompt_tokens is fractional', { prompt_tokens: 10.5, completion_tokens: 1200 }],
    ['only the Images API names are present', { input_tokens: 10, output_tokens: 1200 }],
  ])('is null when %s', async (_label, usage) => {
    expect(await usageFor(usage)).toBeNull()
  })
})

describe('refusal and embedded errors on a 2xx', () => {
  const WIRE_USAGE = { prompt_tokens: 10, completion_tokens: 0, cost: 0.001 }

  it.each([
    ['metadata.error_type', { metadata: { error_type: 'moderation' }, code: 403 }],
    ['metadata.code', { metadata: { code: 'moderation' } }],
    ['error.code', { code: 'moderation', message: 'flagged' }],
    ['error.type', { type: 'moderation' }],
  ])(
    'returns refused for a moderation envelope named by %s, keeping usage and cost',
    async (_label, error) => {
      const response = await runImage(200, { error, usage: WIRE_USAGE })
      expect(response).toEqual({
        kind: 'refused',
        text: '',
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.001,
      })
    },
  )

  it('returns refused with usage null and no cost when the body reports neither', async () => {
    const response = await runImage(200, { error: { type: 'moderation' } })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null })
    expect(Object.hasOwn(response, 'costUsd')).toBe(false)
  })

  it.each([
    ['absent', {}],
    ['empty', { data: [] }],
    ['not an array', { data: 'x' }],
    ['null', { data: null }],
  ])('returns refused for a moderation envelope when data is %s', async (_label, data) => {
    const response = await runImage(200, { ...data, error: { type: 'moderation' } })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null })
  })

  it('returns refused for a moderation envelope on the first choice', async () => {
    const response = await runImage(200, {
      choices: [{ finish_reason: 'error', error: { metadata: { error_type: 'moderation' } } }],
    })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null })
  })

  it('keeps the cost of a refusal whose counters are invalid', async () => {
    const response = await runImage(200, {
      error: { type: 'moderation' },
      usage: { prompt_tokens: 'x', completion_tokens: 0, cost: 0 },
    })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null, costUsd: 0 })
  })

  it.each([
    ['auth', { type: 'auth' }, 'auth'],
    ['authentication', { metadata: { error_type: 'authentication' } }, 'auth'],
    ['credit', { code: 'credit' }, 'rate_limit'],
    ['rate_limit', { metadata: { code: 'rate_limit' } }, 'rate_limit'],
    ['rate-limit', { type: 'rate-limit' }, 'rate_limit'],
    ['an unknown word', { type: 'server_error' }, 'transient'],
    ['no word at all', { message: 'upstream failed' }, 'transient'],
  ])(
    'throws the mapped kind for an embedded %s error, with the HTTP status',
    async (_l, error, kind) => {
      const failure = await failureOf(runImage(200, { error }))
      expect(ProviderError.is(failure) && failure.kind === kind).toBe(true)
      expect((failure as ProviderError).status).toBe(200)
    },
  )

  it.each([
    ['empty', { data: [] }],
    ['not an array', { data: { 0: element() } }],
  ])('throws an embedded error when data is %s', async (_label, data) => {
    const failure = await failureOf(runImage(201, { ...data, error: { type: 'credit' } }))
    expect(ProviderError.is(failure) && failure.kind === 'rate_limit').toBe(true)
    expect((failure as ProviderError).status).toBe(201)
  })

  it("throws transient for a first choice with finish_reason 'error' and no error object", async () => {
    const failure = await failureOf(runImage(200, { choices: [{ finish_reason: 'error' }] }))
    expect(ProviderError.is(failure) && failure.kind === 'transient').toBe(true)
  })

  it('reads the envelope behind a custom base URL too', async () => {
    const response = await runImage(
      200,
      { error: { type: 'moderation' } },
      { baseUrl: 'https://example.com/openrouter/v1' },
    )
    expect(response.kind).toBe('refused')
  })

  it('reads an error that is not a record as no embedded error', async () => {
    const response = await runImage(200, imagesBody({ error: 'moderation' }, []))
    expect(response).toEqual({ kind: 'complete', text: '', images: [], usage: null })
  })
})

describe('images win over an embedded error', () => {
  // OpenRouter bills an image call all or nothing and answers a failed generation with a 502
  // it does not bill: images in a 2xx are what was bought, whatever else the body says.
  const IMAGE = { mediaType: 'image/png', data: PNG_DATA }

  it.each([
    ['a moderation envelope', { error: { type: 'moderation' } }],
    ['the documented moderation metadata', MODERATION_METADATA_BODY],
    ['a rate-limit word', { error: { metadata: { error_type: 'rate_limit_exceeded' } } }],
    ['an auth word', { error: { error_type: 'permission_denied' } }],
    ['an error naming nothing', { error: { code: 500, message: 'failed' } }],
    ["a first choice with finish_reason 'error'", { choices: [{ finish_reason: 'error' }] }],
  ])('reads the images beside %s as the answer', async (_label, extra) => {
    const response = await runImage(200, {
      ...imagesBody(),
      ...extra,
      usage: { prompt_tokens: 10, completion_tokens: 1200, cost: 0.04 },
    })
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [IMAGE],
      usage: { inputTokens: 10, outputTokens: 1200 },
      costUsd: 0.04,
    })
  })

  it('holds images beside an embedded error to every element rule', async () => {
    await expectMalformed(
      imagesBody({ error: { type: 'credit' } }, [element(), element('AAA')]),
    )
    await expectMalformed(
      imagesBody({ error: { type: 'moderation' } }, [element(PNG_DATA, 'image/svg+xml')]),
    )
  })

  it('applies the count cap to images beside an embedded error', async () => {
    const tooMany = Array.from({ length: 33 }, () => element())
    await expectMalformed(imagesBody({ error: { type: 'moderation' } }, tooMany))
  })
})

describe('error classification', () => {
  it.each([
    [
      '403 with moderation metadata -> invalid_request',
      403,
      { error: { metadata: { error_type: 'moderation' } } },
      'invalid_request',
    ],
    [
      '403 with a moderation type -> invalid_request',
      403,
      { error: { type: 'moderation' } },
      'invalid_request',
    ],
    ['403 without moderation -> auth', 403, {}, 'auth'],
    ['403 with another word -> auth', 403, { error: { type: 'forbidden' } }, 'auth'],
    ['401 -> auth', 401, {}, 'auth'],
    ['401 with moderation metadata -> auth', 401, { error: { type: 'moderation' } }, 'auth'],
    ['404 -> model_not_found', 404, {}, 'model_not_found'],
    ['402 -> rate_limit', 402, {}, 'rate_limit'],
    ['429 -> rate_limit', 429, {}, 'rate_limit'],
    ['408 -> transient', 408, {}, 'transient'],
    ['498 -> transient', 498, {}, 'transient'],
    ['500 -> transient', 500, {}, 'transient'],
    ['503 -> transient', 503, {}, 'transient'],
    [
      '422 with a model_not_found code -> model_not_found',
      422,
      { error: { code: 'model_not_found' } },
      'model_not_found',
    ],
    ['422 -> invalid_request', 422, {}, 'invalid_request'],
    ['400 -> invalid_request', 400, {}, 'invalid_request'],
    [
      '400 with moderation metadata -> invalid_request',
      400,
      { error: { type: 'moderation' } },
      'invalid_request',
    ],
    ['418, named by no row -> invalid_request', 418, {}, 'invalid_request'],
    ['an unparseable 502 -> transient', 502, null, 'transient'],
  ])('%s', async (_label, status, body, expectedKind) => {
    const error = await failureOf(runImage(status, body))
    expect(ProviderError.is(error) && error.kind === expectedKind).toBe(true)
    expect((error as ProviderError).status).toBe(status)
  })

  it('never answers refused on a non-2xx, moderation or not', async () => {
    for (const status of [400, 403, 451, 500]) {
      const error = await failureOf(runImage(status, { error: { type: 'moderation' } }))
      expect(ProviderError.is(error)).toBe(true)
    }
  })

  it('applies the 403 moderation rule behind a custom base URL', async () => {
    installFetch(() => jsonResponse(403, { error: { type: 'moderation' } }))
    const run = await complete({ baseUrl: 'https://example.com/gateway/v1' })
    await expect(run(imageRequest())).rejects.toSatisfy(isKind('invalid_request'))
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
    ['an embedded error', 200, { error: { type: 'credit', message: `bad: ${SENTINEL}` } }],
    ['a malformed image', 200, imagesBody({}, [element(`${SENTINEL}=`)])],
    ['an unknown media type', 200, imagesBody({}, [element(PNG_DATA, SENTINEL)])],
  ])('never embeds the payload of %s in a thrown message', async (_label, status, body) => {
    installFetch(() => jsonResponse(status, body))
    const run = await complete()
    const error = await failureOf(run(imageRequest({}, { parts: textParts(SENTINEL) })))
    expect(ProviderError.is(error)).toBe(true)
    expect((error as Error).message).not.toContain(SENTINEL)
  })
})

describe("OpenRouter's documented error vocabulary", () => {
  const BILLED = { prompt_tokens: 10, completion_tokens: 0, cost: 0.001 }

  function everyLocation(words: readonly string[]) {
    return words.flatMap((word) =>
      ERROR_TYPE_LOCATIONS.map((location) => [word, location] as const),
    )
  }

  async function failureKind(status: number, body: unknown) {
    const error = await failureOf(runImage(status, body))
    expect(ProviderError.is(error)).toBe(true)
    expect((error as ProviderError).status).toBe(status)
    return (error as ProviderError).kind
  }

  it('classifies a 403 carrying moderation metadata, and no type, as invalid_request', async () => {
    expect(await failureKind(403, MODERATION_METADATA_BODY)).toBe('invalid_request')
  })

  it.each(everyLocation(MODERATION_WORDS))(
    'classifies a 403 naming %s by %s as invalid_request',
    async (word, location) => {
      expect(await failureKind(403, typedErrorBody(location, word, 403))).toBe(
        'invalid_request',
      )
    },
  )

  it.each(ERROR_TYPE_LOCATIONS)(
    'classifies a 403 naming permission_denied by %s as auth',
    async (location) => {
      expect(await failureKind(403, typedErrorBody(location, 'permission_denied', 403))).toBe(
        'auth',
      )
    },
  )

  it('returns refused for moderation metadata embedded in a 200, keeping usage and cost', async () => {
    const response = await runImage(200, { ...MODERATION_METADATA_BODY, usage: BILLED })
    expect(response).toEqual({
      kind: 'refused',
      text: '',
      usage: { inputTokens: 10, outputTokens: 0 },
      costUsd: 0.001,
    })
  })

  it.each(everyLocation(MODERATION_WORDS))(
    'returns refused for an embedded %s named by %s, keeping usage and cost',
    async (word, location) => {
      const response = await runImage(200, { ...typedErrorBody(location, word), usage: BILLED })
      expect(response).toEqual({
        kind: 'refused',
        text: '',
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.001,
      })
    },
  )

  it.each(everyLocation(AUTH_WORDS))(
    'classifies an embedded %s named by %s as auth',
    async (word, location) => {
      expect(await failureKind(200, typedErrorBody(location, word))).toBe('auth')
    },
  )

  it.each(everyLocation(RATE_LIMIT_WORDS))(
    'classifies an embedded %s named by %s as rate_limit',
    async (word, location) => {
      expect(await failureKind(200, typedErrorBody(location, word))).toBe('rate_limit')
    },
  )

  it.each(OTHER_WORDS)('classifies an embedded %s as transient', async (word) => {
    expect(await failureKind(200, typedErrorBody('metadata.error_type', word))).toBe(
      'transient',
    )
  })
})
