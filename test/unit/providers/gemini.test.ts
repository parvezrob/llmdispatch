import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { gemini } from '../../../src/providers/gemini'
import { isWireBase64 } from '../../../src/providers/transport'
import type * as transportModule from '../../../src/providers/transport'
import type { ImageOptions, ProviderRequest } from '../../../src/types'
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

const KEY = () => 'goog-key-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function complete() {
  return withPrepared(gemini({ apiKey: KEY }))
}

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
}

describe('request shape', () => {
  it('builds the URL from HOST, path and the encoded model', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ model: 'gemini-x' }))
    expect(requests[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent',
    )
  })

  // A model containing URL-meaningful characters proves encodeURIComponent runs, not a bare
  // string interpolation: an unencoded value would change the request path (D11).
  it.each([
    ['slash', 'org/model', 'org%2Fmodel'],
    ['question mark', 'model?x', 'model%3Fx'],
    ['hash', 'model#tag', 'model%23tag'],
  ])('encodes a model containing a %s', async (_label, model, encoded) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ model }))
    expect(requests[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${encoded}:generateContent`,
    )
  })

  it('sends x-goog-api-key, not Authorization', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.headers['x-goog-api-key']).toBe('goog-key-test')
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  it('sends the prompt as contents[0].parts[0].text', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ parts: textParts('say hi') }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'say hi' }] }])
  })

  it('omits generationConfig entirely when no optional field applies', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect('generationConfig' in (requests[0]!.body as Record<string, unknown>)).toBe(false)
  })

  it('sends maxOutputTokens and temperature inside generationConfig when set', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ maxOutputTokens: 256, temperature: 0.5 }))
    const config = (requests[0]!.body as Record<string, unknown>).generationConfig as Record<
      string,
      unknown
    >
    expect(config.maxOutputTokens).toBe(256)
    expect(config.temperature).toBe(0.5)
    expect('responseMimeType' in config).toBe(false)
  })

  it('sets responseMimeType only for json-object format, not json-any or text', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ responseFormat: { type: 'json', topLevel: 'object' } }))
    const config = (requests[0]!.body as Record<string, unknown>).generationConfig as Record<
      string,
      unknown
    >
    expect(config.responseMimeType).toBe('application/json')
  })

  it.each([
    ['json-any', { type: 'json', topLevel: 'any' } as const],
    ['text', { type: 'text' } as const],
  ])('omits responseMimeType and generationConfig for %s', async (_label, responseFormat) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ responseFormat }))
    expect('generationConfig' in (requests[0]!.body as Record<string, unknown>)).toBe(false)
  })

  it("always fetches with redirect: 'error'", async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.redirect).toBe('error')
  })

  it('passes the exact request signal through to fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    const req = baseRequest()
    await run(req)
    expect(requests[0]!.signal).toBe(req.signal)
  })
})

describe('termination mapping', () => {
  it('maps promptFeedback.blockReason to refused before the no-candidates check', async () => {
    installFetch(() => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }))
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
    expect(response.text).toBe('')
  })

  it('throws malformed_response for no candidates without block metadata', async () => {
    installFetch(() => jsonResponse(200, { candidates: [] }))
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it("maps finishReason 'MAX_TOKENS' to truncated", async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'truncated', text: 'partial', usage: null })
  })

  it.each([
    'SAFETY',
    'RECITATION',
    'PROHIBITED_CONTENT',
    'BLOCKLIST',
    'SPII',
    'ESCALATION',
    'LANGUAGE',
  ])("maps finishReason '%s' to refused", async (finishReason) => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
  })

  it("maps finishReason 'STOP' to complete", async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'complete', text: 'done', usage: null })
  })

  it('throws malformed_response for an unrecognized finishReason', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'OTHER' }],
      }),
    )
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it('concatenates multiple text parts', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [
          { content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'STOP' },
        ],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.text).toBe('ab')
  })
})

describe('image mode: the request', () => {
  function imageRequest(image: ImageOptions = {}): ProviderRequest {
    return baseRequest({ responseFormat: { type: 'image', ...image } })
  }

  async function configFor(image: ImageOptions = {}): Promise<Record<string, unknown>> {
    const { requests } = captureRequests(() => jsonResponse(200, imageBody([imageCandidate()])))
    const run = await complete()
    await run(imageRequest(image))
    const body = requests[0]!.body as Record<string, unknown>
    return body.generationConfig as Record<string, unknown>
  }

  it('sends the two response modalities and nothing else when no knob is set', async () => {
    const config = await configFor()
    expect(config).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })

  it('never sends responseMimeType in image mode', async () => {
    const config = await configFor({ aspectRatio: '1:1' })
    expect('responseMimeType' in config).toBe(false)
  })

  it('sends aspectRatio alone inside imageConfig', async () => {
    const config = await configFor({ aspectRatio: '16:9' })
    expect(config.imageConfig).toEqual({ aspectRatio: '16:9' })
    expect('candidateCount' in config).toBe(false)
  })

  it('sends size alone as imageConfig.imageSize, verbatim', async () => {
    const config = await configFor({ size: '4K' })
    expect(config.imageConfig).toEqual({ imageSize: '4K' })
  })

  it('sends count alone as candidateCount, with no imageConfig', async () => {
    const config = await configFor({ count: 3 })
    expect(config.candidateCount).toBe(3)
    expect('imageConfig' in config).toBe(false)
  })

  it('sends every knob together', async () => {
    const config = await configFor({ count: 2, aspectRatio: '3:4', size: '2K' })
    expect(config).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '3:4', imageSize: '2K' },
      candidateCount: 2,
    })
  })

  it("sends nothing extra for background 'opaque'", async () => {
    const config = await configFor({ background: 'opaque' })
    expect(config).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })

  it('keeps maxOutputTokens and temperature alongside the image fields', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, imageBody([imageCandidate()])))
    const run = await complete()
    await run(
      baseRequest({
        responseFormat: { type: 'image', count: 2 },
        maxOutputTokens: 256,
        temperature: 0.5,
      }),
    )
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 256,
      temperature: 0.5,
      responseModalities: ['TEXT', 'IMAGE'],
      candidateCount: 2,
    })
  })

  it("rejects background 'transparent' as invalid_request without touching fetch", async () => {
    const { requests } = captureRequests()
    const run = await complete()
    await expect(run(imageRequest({ background: 'transparent' }))).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'invalid_request',
    )
    expect(requests).toHaveLength(0)
  })
})

const PNG_DATA = base64(png(2, 3))

/** One `inlineData` part in the spelling the REST responses print. */
function imagePart(data = PNG_DATA, mimeType = 'image/png') {
  return { inlineData: { mimeType, data } }
}

function imageCandidate(parts: unknown[] = [imagePart()], finishReason = 'STOP') {
  return { content: { parts }, finishReason }
}

function imageBody(candidates: unknown[], usageMetadata?: unknown) {
  return usageMetadata === undefined ? { candidates } : { candidates, usageMetadata }
}

async function runImage(body: unknown, image: ImageOptions = {}) {
  installFetch(() => jsonResponse(200, body))
  const run = await complete()
  return run(baseRequest({ responseFormat: { type: 'image', ...image } }))
}

function expectMalformed(body: unknown): Promise<void> {
  return expect(runImage(body)).rejects.toSatisfy(
    (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
  ) as Promise<void>
}

describe('image mode: images and text', () => {
  it('reads one inline image, leaving the dimensions to the core', async () => {
    const response = await runImage(imageBody([imageCandidate()]))
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: null,
    })
  })

  it('keeps the order of images across candidates and parts', async () => {
    const other = base64(png(4, 5))
    const response = await runImage(
      imageBody([
        imageCandidate([imagePart(), imagePart(other)]),
        imageCandidate([imagePart(other, 'image/webp')]),
      ]),
    )
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA },
      { mediaType: 'image/png', data: other },
      { mediaType: 'image/webp', data: other },
    ])
  })

  it('reads the snake_case spelling of the inline part', async () => {
    const body = imageBody([
      imageCandidate([{ inline_data: { mime_type: 'image/jpeg', data: PNG_DATA } }]),
    ])
    const response = await runImage(body)
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/jpeg', data: PNG_DATA },
    ])
  })

  it('reads the camelCase spelling when one part carries both, disagreeing', async () => {
    const other = base64(png(4, 5))
    const body = imageBody([
      imageCandidate([
        {
          inlineData: { mimeType: 'image/png', data: PNG_DATA },
          inline_data: { mime_type: 'image/webp', data: other },
        },
      ]),
    ])
    const response = await runImage(body)
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: PNG_DATA },
    ])
  })

  it('concatenates text across candidates and keeps it beside the images', async () => {
    const response = await runImage(
      imageBody([
        imageCandidate([{ text: 'a ' }, imagePart(), { text: 'fox' }]),
        imageCandidate([{ text: ' and one more' }]),
      ]),
    )
    expect(response.text).toBe('a fox and one more')
    expect(response.kind === 'complete' && response.images).toHaveLength(1)
  })

  it.each([
    ['an unknown mime', [{ inlineData: { mimeType: 'image/gif', data: PNG_DATA } }]],
    ['a non-string data', [{ inlineData: { mimeType: 'image/png', data: 1 } }]],
    ['base64 the grammar rejects', [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }]],
    ['a data-URL prefix', [{ inlineData: { mimeType: 'image/png', data: 'data:image/png' } }]],
    ['a non-record inline part', [{ inlineData: 'AAAA' }]],
    ['a null inline part', [{ inlineData: null }]],
    ['a part that is not a record', ['AAAA']],
  ])('throws malformed_response for %s', async (_label, parts) => {
    await expectMalformed(imageBody([imageCandidate(parts)]))
  })

  it('weighs a candidate that is not a record as an unknown reason', async () => {
    await expectMalformed(imageBody([imageCandidate(), 'candidate']))
  })

  // A STOP candidate that then states no content is a shape failure, not an empty answer.
  it.each([
    ['content.parts is not an array', { content: { parts: { 0: imagePart() } } }],
    ['content is absent', { finishReason: 'STOP' }],
    ['content is not a record', { content: 'parts', finishReason: 'STOP' }],
  ])(
    'throws malformed_response when a contributing candidate has %s',
    async (_label, extra) => {
      await expectMalformed(imageBody([{ finishReason: 'STOP', ...extra }]))
    },
  )

  it('maps promptFeedback.blockReason to refused before reading candidates', async () => {
    const response = await runImage({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: 'garbage',
    })
    expect(response).toEqual({ kind: 'refused', text: '', usage: null })
  })

  it('throws malformed_response for no candidates without block metadata', async () => {
    await expectMalformed({ candidates: [] })
  })
})

describe('image mode: the response caps', () => {
  // The adapter states the §3 point 4b caps on its own side: the core would reject the same
  // response, but only after the grammar had run over every oversized string in it.
  const OVERSIZED = 'A'.repeat(30_000_004)
  const AT_CAP = 'A'.repeat(30_000_000)

  function parts(count: number) {
    return Array.from({ length: count }, () => imagePart())
  }

  it('reads thirty-two image parts across candidates', async () => {
    const response = await runImage(
      imageBody([imageCandidate(parts(20)), imageCandidate(parts(12))]),
    )
    expect(response.kind === 'complete' && response.images).toHaveLength(32)
  })

  it('throws malformed_response on the thirty-third part, before its grammar scan', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imageBody([imageCandidate(parts(20)), imageCandidate(parts(13))]))
    expect(isWireBase64).toHaveBeenCalledTimes(32)
  })

  it('reads a part whose data is exactly the per-image cap', async () => {
    const response = await runImage(imageBody([imageCandidate([imagePart(AT_CAP)])]))
    expect(response.kind === 'complete' && response.images).toEqual([
      { mediaType: 'image/png', data: AT_CAP },
    ])
  })

  it('throws malformed_response on over-long data, without running the grammar', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(imageBody([imageCandidate([imagePart(OVERSIZED)])]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })
})

describe('image mode: the finish-reason precedence', () => {
  it.each(['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'SAFETY'])(
    "maps '%s' to refused",
    async (finishReason) => {
      const response = await runImage(
        imageBody([imageCandidate([{ text: 'sorry' }], finishReason)]),
      )
      expect(response).toEqual({ kind: 'refused', text: 'sorry', usage: null })
    },
  )

  it("maps 'MAX_TOKENS' to truncated, carrying text and no images", async () => {
    const response = await runImage(
      imageBody([imageCandidate([{ text: 'part' }, imagePart()], 'MAX_TOKENS')]),
    )
    expect(response).toEqual({ kind: 'truncated', text: 'part', usage: null })
  })

  it('truncates on one candidate while another stopped, keeping every text', async () => {
    const body = imageBody([
      imageCandidate([{ text: 'A' }], 'MAX_TOKENS'),
      imageCandidate([{ text: 'B' }, imagePart()]),
    ])
    const response = await runImage(body)
    expect(response).toEqual({ kind: 'truncated', text: 'AB', usage: null })
    expect(response).not.toHaveProperty('images')
  })

  it.each(['IMAGE_OTHER', 'SOMETHING_NEW'])(
    "throws malformed_response for '%s'",
    async (finishReason) => {
      await expectMalformed(imageBody([imageCandidate([imagePart()], finishReason)]))
    },
  )

  it.each([
    ['refused first', 'IMAGE_SAFETY', 'MAX_TOKENS'],
    ['truncated first', 'MAX_TOKENS', 'IMAGE_SAFETY'],
  ])('lets a refused candidate beat a truncated one, %s', async (_label, one, two) => {
    const body = imageBody([
      imageCandidate([{ text: 'a' }], one),
      imageCandidate([{ text: 'b' }], two),
    ])
    const response = await runImage(body)
    expect(response).toEqual({ kind: 'refused', text: 'ab', usage: null })
  })

  it('carries no images on a refusal, even when a candidate holds an image part', async () => {
    const body = imageBody([
      imageCandidate([{ text: 'sorry' }, imagePart()], 'IMAGE_SAFETY'),
      imageCandidate(),
    ])
    const response = await runImage(body)
    expect(response).toEqual({ kind: 'refused', text: 'sorry', usage: null })
    expect(response).not.toHaveProperty('images')
  })

  it.each([
    ['an unmappable reason', imageCandidate([{ text: '' }], 'IMAGE_OTHER')],
    ['a candidate that is not a record', 'candidate'],
  ])('lets a refused candidate beat %s', async (_label, other) => {
    const body = imageBody([other, imageCandidate([{ text: '' }], 'IMAGE_RECITATION')])
    expect((await runImage(body)).kind).toBe('refused')
  })

  it('lets a truncated candidate beat an unmappable one', async () => {
    const body = imageBody([
      imageCandidate([{ text: '' }], 'IMAGE_OTHER'),
      imageCandidate([{ text: '' }], 'MAX_TOKENS'),
    ])
    expect((await runImage(body)).kind).toBe('truncated')
  })

  it('answers complete with no images when every candidate is NO_IMAGE', async () => {
    const response = await runImage(
      imageBody([imageCandidate([{ text: 'no picture' }], 'NO_IMAGE')]),
    )
    expect(response).toEqual({ kind: 'complete', text: '', images: [], usage: null })
  })

  it('takes nothing from a NO_IMAGE candidate beside a STOP one', async () => {
    const response = await runImage(
      imageBody([
        imageCandidate([{ text: 'kept ' }, imagePart()]),
        imageCandidate([{ text: 'dropped' }, imagePart()], 'NO_IMAGE'),
      ]),
    )
    expect(response).toEqual({
      kind: 'complete',
      text: 'kept ',
      images: [{ mediaType: 'image/png', data: PNG_DATA }],
      usage: null,
    })
  })
})

describe('image mode: the usage split', () => {
  const BASE = { promptTokenCount: 10, candidatesTokenCount: 1200 }

  async function usageFor(candidatesTokensDetails: unknown) {
    const response = await runImage(
      imageBody([imageCandidate()], { ...BASE, candidatesTokensDetails }),
    )
    return response.usage
  }

  it('reads the IMAGE modality entry into imageOutputTokens', async () => {
    const usage = await usageFor([
      { modality: 'TEXT', tokenCount: 80 },
      { modality: 'IMAGE', tokenCount: 1120 },
    ])
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200, imageOutputTokens: 1120 })
  })

  it('takes the first IMAGE entry when several are reported', async () => {
    const usage = await usageFor([
      { modality: 'IMAGE', tokenCount: 747 },
      { modality: 'IMAGE', tokenCount: 1120 },
    ])
    expect(usage).toMatchObject({ imageOutputTokens: 747 })
  })

  it('omits the field when no IMAGE entry is reported', async () => {
    const usage = await usageFor([{ modality: 'TEXT', tokenCount: 80 }])
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(usage).not.toHaveProperty('imageOutputTokens')
  })

  it.each([
    ['a negative count', [{ modality: 'IMAGE', tokenCount: -1 }]],
    ['a fractional count', [{ modality: 'IMAGE', tokenCount: 1.5 }]],
    ['a non-number count', [{ modality: 'IMAGE', tokenCount: '1120' }]],
    ['a count above the output tokens', [{ modality: 'IMAGE', tokenCount: 1201 }]],
    ['a non-record entry', ['IMAGE']],
    ['details that are not an array', { modality: 'IMAGE', tokenCount: 1120 }],
    ['a count past the safe integers', [{ modality: 'IMAGE', tokenCount: 2 ** 53 }]],
    ['a null count', [{ modality: 'IMAGE', tokenCount: null }]],
  ])('omits the field for %s, keeping the base counters', async (_label, details) => {
    const usage = await usageFor(details)
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(usage).not.toHaveProperty('imageOutputTokens')
  })

  // `JSON.stringify` turns a non-finite number into `null`, so the only way to put one on
  // the wire is to script the body text: `1e400` parses back as `Infinity`.
  it('omits the field for a non-finite count', async () => {
    const raw =
      `{"candidates":${JSON.stringify([imageCandidate()])},` +
      '"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1200,' +
      '"candidatesTokensDetails":[{"modality":"IMAGE","tokenCount":1e400}]}}'
    installFetch(
      () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const run = await complete()
    const response = await run(baseRequest({ responseFormat: { type: 'image' } }))
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(response.usage).not.toHaveProperty('imageOutputTokens')
  })

  it('keeps usage null when the base counters are missing', async () => {
    const response = await runImage(
      imageBody([imageCandidate()], {
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
      }),
    )
    expect(response.usage).toBeNull()
  })

  // A text operation cannot produce images, so the wire does not get to pick the pricing
  // basis for the attempt: the split is read in image mode only.
  it('omits the split on a text run, even when an IMAGE entry is reported', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          ...BASE,
          candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 5 }],
        },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 1200 })
    expect(response.usage).not.toHaveProperty('imageOutputTokens')
  })
})

describe('text mode beside the image wire', () => {
  it('still reads candidates[0] only', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [
          { content: { parts: [{ text: 'first' }] }, finishReason: 'STOP' },
          { content: { parts: [{ text: 'second' }] }, finishReason: 'MAX_TOKENS' },
        ],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'complete', text: 'first', usage: null })
  })

  it.each(['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'])(
    "maps '%s' to refused rather than malformed",
    async (finishReason) => {
      installFetch(() =>
        jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason }] }),
      )
      const run = await complete()
      expect((await run(baseRequest())).kind).toBe('refused')
    },
  )

  it('never sends the image fields', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ maxOutputTokens: 8 }))
    const config = (requests[0]!.body as Record<string, unknown>).generationConfig as Record<
      string,
      unknown
    >
    expect(config).toEqual({ maxOutputTokens: 8 })
  })
})

describe('error classification', () => {
  it.each([
    ['401 -> auth', 401, {}, 'auth'],
    ['403 -> auth', 403, {}, 'auth'],
    ['404 -> model_not_found', 404, {}, 'model_not_found'],
    ['429 -> rate_limit', 429, {}, 'rate_limit'],
    [
      'RESOURCE_EXHAUSTED status string -> rate_limit',
      400,
      { error: { status: 'RESOURCE_EXHAUSTED' } },
      'rate_limit',
    ],
    ['500 -> transient', 500, {}, 'transient'],
    ['503 -> transient', 503, {}, 'transient'],
    ['400 -> invalid_request', 400, {}, 'invalid_request'],
    [
      'INVALID_ARGUMENT status string -> invalid_request',
      418,
      { error: { status: 'INVALID_ARGUMENT' } },
      'invalid_request',
    ],
    ['498 family default -> invalid_request', 498, {}, 'invalid_request'],
  ])('%s', async (_label, status, body, expectedKind) => {
    installFetch(() => jsonResponse(status, body))
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === expectedKind,
    )
  })

  it('classifies an abort-triggered fetch rejection as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    installFetch(() => {
      throw new Error('fetch aborted')
    })
    const run = await complete()
    await expect(run(baseRequest({ signal: controller.signal }))).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'aborted',
    )
  })

  it('classifies a plain network failure (no abort) as transient', async () => {
    installFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )
  })

  it('never embeds the fixture body sentinel in a thrown message', async () => {
    installFetch(() => jsonResponse(400, { error: { message: `bad: ${SENTINEL}` } }))
    const run = await complete()
    try {
      await run(baseRequest({ parts: textParts(SENTINEL) }))
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL)
    }
  })
})

describe('usage normalization', () => {
  it('requires promptTokenCount and candidatesTokenCount; missing -> null', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it.each([
    ['non-number promptTokenCount', { promptTokenCount: '10', candidatesTokenCount: 5 }],
    ['negative candidatesTokenCount', { promptTokenCount: 10, candidatesTokenCount: -5 }],
    ['fractional promptTokenCount', { promptTokenCount: 10.5, candidatesTokenCount: 5 }],
  ])('is null when %s', async (_label, usageMetadata) => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata,
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it('adds thoughtsTokenCount into outputTokens, default 0 when absent', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 8 })
  })

  it('is null when thoughtsTokenCount is present but invalid, never coerced to 0', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: -1,
        },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })
})
