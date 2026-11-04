/**
 * `openrouterImages` asked for SVG (spec §5c): the svg gate, the request body a vectorization
 * model receives, and how an svg answer is read, capped and billed. The image path, the
 * error rows and the shared envelope rules are pinned in `openrouter-images.test.ts`; the
 * core's document check runs in `openrouter-images-run.test.ts`, never here, since the
 * adapter does not run it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { openrouterImages } from '../../../src/providers/openrouter-images'
import { fetchJson, isWireBase64 } from '../../../src/providers/transport'
import type * as transportModule from '../../../src/providers/transport'
import type { ContentPart, ProviderRequest, SvgOptions } from '../../../src/types'
import { base64, png } from '../core/image-fixtures'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  SENTINEL,
  withPrepared,
} from './helpers'
import { MODERATION_METADATA_BODY } from './openrouter-fixtures'

// The module keeps its real behaviour; the wrappers only make the grammar scan observable,
// so the cap tests can show what the adapter never reaches, and let those tests hand the
// adapter a parsed body without serializing tens of megabytes. Vitest hoists this above the
// imports above.
vi.mock('../../../src/providers/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof transportModule>()
  return {
    ...actual,
    fetchJson: vi.fn(actual.fetchJson),
    isWireBase64: vi.fn(actual.isWireBase64),
  }
})

const KEY = () => 'sk-or-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function complete() {
  return withPrepared(openrouterImages({ apiKey: KEY }))
}

/** A document's UTF-8 bytes as base64, the way the Image API carries it in `b64_json`. */
function svgData(markup: string): string {
  return Buffer.from(markup, 'utf8').toString('base64')
}

const SVG_DATA = svgData('<svg/>')
const PNG_DATA = base64(png(2, 3))

function svgRequest(svg: SvgOptions = {}, overrides: Partial<ProviderRequest> = {}) {
  return baseRequest({ responseFormat: { type: 'svg', ...svg }, ...overrides })
}

/** One `data[]` element as a vector model answers it. */
function element(data: string = SVG_DATA, mediaType: unknown = 'image/svg+xml') {
  return { b64_json: data, media_type: mediaType }
}

/** `count` copies of one element. */
function elements(count: number, data: string = SVG_DATA) {
  return Array.from({ length: count }, () => element(data))
}

/** An Image API answer: the `data` array, plus any top-level fields. */
function svgBody(extra: Record<string, unknown> = {}, data: unknown[] = [element()]) {
  return { data, ...extra }
}

/** The body the adapter sent for one svg request, answered with one document. */
async function sentBody(
  svg: SvgOptions = {},
  overrides: Partial<ProviderRequest> = {},
): Promise<Record<string, unknown>> {
  const { requests } = captureRequests(() => jsonResponse(200, svgBody()))
  const run = await complete()
  await run(svgRequest(svg, overrides))
  expect(requests).toHaveLength(1)
  return requests[0]!.body as Record<string, unknown>
}

async function runSvg(status: number, body: unknown) {
  installFetch(() => jsonResponse(status, body))
  const run = await complete()
  return run(svgRequest())
}

/** The thrown value of a run, or `null` when it resolved. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (thrown: unknown) => thrown,
  )
}

async function expectMalformed(body: unknown, status = 200): Promise<void> {
  const error = await failureOf(runSvg(status, body))
  expect(ProviderError.is(error) && error.kind === 'malformed_response').toBe(true)
  expect((error as ProviderError).status).toBe(status)
}

describe('the svg gate', () => {
  const PDF: ContentPart = { type: 'file', mediaType: 'application/pdf', data: 'AAAA' }
  const PICTURE: ContentPart = { type: 'file', mediaType: 'image/png', data: PNG_DATA }

  async function expectGate(req: ProviderRequest, message: string): Promise<void> {
    const { requests } = captureRequests(() => jsonResponse(200, svgBody()))
    const run = await complete()
    const error = await failureOf(run(req))
    expect(ProviderError.is(error) && error.kind === 'invalid_request').toBe(true)
    expect((error as Error).message).toBe(message)
    expect(requests).toHaveLength(0)
  }

  it.each([
    ['a bare svg request', {}],
    ['an svg request with both knobs', { count: 2, aspectRatio: '1:1' } as const],
  ])('accepts %s, with one fetch', async (_label, svg) => {
    const { requests } = captureRequests(() => jsonResponse(200, svgBody()))
    const run = await complete()
    const response = await run(svgRequest(svg))
    expect(response.kind).toBe('complete')
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['text', { type: 'text' } as const],
    ['json object', { type: 'json', topLevel: 'object' } as const],
    ['json any', { type: 'json', topLevel: 'any' } as const],
  ])('still rejects a %s request', async (_label, responseFormat) => {
    await expectGate(baseRequest({ responseFormat }), 'only image or svg output is supported')
  })

  it.each([
    ['a PDF part', [{ type: 'text', text: 'draw it' }, PDF]],
    ['an image part', [{ type: 'text', text: 'trace this' }, PICTURE]],
    ['a lone image part', [PICTURE]],
  ] as const)('rejects an svg request carrying %s', async (_label, parts) => {
    await expectGate(svgRequest({}, { parts }), 'file parts are not supported')
  })
})

describe('the svg body', () => {
  const BASE = { model: 'test-model', prompt: 'hello', output_format: 'svg' }

  it("sends exactly model, prompt and output_format 'svg' when no knob is set", async () => {
    const body = await sentBody({}, { model: 'recraft/recraft-vector-x' })
    expect(Object.keys(body).sort()).toEqual(['model', 'output_format', 'prompt'])
    expect(body).toEqual({
      model: 'recraft/recraft-vector-x',
      prompt: 'hello',
      output_format: 'svg',
    })
  })

  it('sends count alone as n', async () => {
    expect(await sentBody({ count: 4 })).toEqual({ ...BASE, n: 4 })
  })

  it.each(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const)(
    'sends aspectRatio %s alone, verbatim, as aspect_ratio',
    async (aspectRatio) => {
      expect(await sentBody({ aspectRatio })).toEqual({ ...BASE, aspect_ratio: aspectRatio })
    },
  )

  it('sends both knobs together, each in its own field', async () => {
    const body = await sentBody({ count: 6, aspectRatio: '9:16' })
    expect(Object.keys(body).sort()).toEqual([
      'aspect_ratio',
      'model',
      'n',
      'output_format',
      'prompt',
    ])
    expect(body).toEqual({ ...BASE, n: 6, aspect_ratio: '9:16' })
  })

  it('drops maxOutputTokens and temperature, which have no field on this wire', async () => {
    const body = await sentBody({}, { maxOutputTokens: 256, temperature: 0.5 })
    expect(body).toEqual(BASE)
  })

  it('never sends resolution or background, even from a request that carries them', async () => {
    // The type gives an svg block neither knob; a request built around the type still sends
    // only the svg knobs.
    const responseFormat = {
      type: 'svg',
      count: 1,
      size: '4K',
      background: 'transparent',
      quality: 'high',
    } as unknown as ProviderRequest['responseFormat']
    const body = await sentBody({}, { responseFormat })
    expect(body).toEqual({ ...BASE, n: 1 })
  })

  it('joins several text parts into the prompt, as for images', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'a fox' },
      { type: 'text', text: 'flat, two colours' },
    ]
    const body = await sentBody({}, { parts })
    expect(body.prompt).toBe('a fox\nflat, two colours')
  })
})

describe('the svg response', () => {
  it('reads one document, with empty text and never an images field', async () => {
    const response = await runSvg(200, svgBody())
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [{ mediaType: 'image/svg+xml', data: SVG_DATA }],
      usage: null,
    })
    expect(response).not.toHaveProperty('images')
    expect(response).not.toHaveProperty('costUsd')
  })

  it('keeps the order of several documents', async () => {
    const second = svgData('<svg><rect/></svg>')
    const third = svgData('<svg><circle/></svg>')
    const response = await runSvg(
      200,
      svgBody({}, [element(), element(second), element(third)]),
    )
    expect(response.kind === 'complete' && response.svgs).toEqual([
      { mediaType: 'image/svg+xml', data: SVG_DATA },
      { mediaType: 'image/svg+xml', data: second },
      { mediaType: 'image/svg+xml', data: third },
    ])
  })

  it('hands the base64 over unchanged, without running the document check', async () => {
    // Grammatical base64 whose bytes are no SVG at all: the core refuses it, not the adapter.
    const notADocument = svgData('<!DOCTYPE svg><svg/>')
    const response = await runSvg(200, svgBody({}, [element(notADocument)]))
    expect(response.kind === 'complete' && response.svgs).toEqual([
      { mediaType: 'image/svg+xml', data: notADocument },
    ])
  })

  it('answers complete with svgs: [] for an empty data array', async () => {
    const response = await runSvg(200, svgBody({}, []))
    expect(response).toEqual({ kind: 'complete', text: '', svgs: [], usage: null })
    expect(response).not.toHaveProperty('images')
  })

  it('ignores the fields it does not read', async () => {
    const response = await runSvg(
      200,
      svgBody({ created: 1, model: 'x' }, [{ ...element(), revised_prompt: 'a fox' }]),
    )
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [{ mediaType: 'image/svg+xml', data: SVG_DATA }],
      usage: null,
    })
  })

  it.each([
    ['image/png, a raster answer', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/webp', 'image/webp'],
    ['absent', undefined],
    ['null', null],
    ['upper case', 'IMAGE/SVG+XML'],
    ['with a parameter', 'image/svg+xml; charset=utf-8'],
    ['a bare format name', 'svg'],
    ['an empty string', ''],
    ['a number', 1],
    ['an object', { type: 'image/svg+xml' }],
  ])('throws malformed_response for a media_type that is %s', async (_label, mediaType) => {
    const bad = mediaType === undefined ? { b64_json: SVG_DATA } : element(SVG_DATA, mediaType)
    await expectMalformed(svgBody({}, [bad]))
  })

  it('throws malformed_response for a raster image after a good document', async () => {
    await expectMalformed(svgBody({}, [element(), element(PNG_DATA, 'image/png')]))
  })

  it('reads every media type before running the grammar', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectMalformed(svgBody({}, [element(), element(PNG_DATA, 'image/png')]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })

  it.each([
    ['data is absent', { usage: { prompt_tokens: 0, completion_tokens: 1 } }],
    ['data is not an array', { data: { 0: element() } }],
    ['data is null', { data: null }],
    ['an element is not a record', svgBody({}, [SVG_DATA])],
    ['an element is null', svgBody({}, [element(), null])],
    ['an element is an array', svgBody({}, [[SVG_DATA]])],
    ['b64_json is absent', svgBody({}, [{ media_type: 'image/svg+xml' }])],
    [
      'b64_json is absent beside a url',
      svgBody({}, [{ url: 'https://example.com/x.svg', media_type: 'image/svg+xml' }]),
    ],
    ['b64_json is not a string', svgBody({}, [{ b64_json: 1, media_type: 'image/svg+xml' }])],
    ['b64_json is null', svgBody({}, [{ b64_json: null, media_type: 'image/svg+xml' }])],
    ['b64_json is empty', svgBody({}, [element('')])],
    ['b64_json fails the grammar', svgBody({}, [element('PHN2Zz4')])],
    ['b64_json is raw markup', svgBody({}, [element('<svg/>')])],
    [
      'b64_json carries a data-URL prefix',
      svgBody({}, [element(`data:image/svg+xml;base64,${SVG_DATA}`)]),
    ],
    ['a later element fails the grammar', svgBody({}, [element(), element('PHN2 Zz4=')])],
  ])('throws malformed_response when %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it.each([
    ['null (an empty body)', null],
    ['an array', [element()]],
    ['a string', 'ok'],
  ])('throws malformed_response for a 2xx body that is %s', async (_label, body) => {
    await expectMalformed(body)
  })

  it('throws malformed_response with the HTTP status', async () => {
    await expectMalformed(svgBody({}, [element(PNG_DATA, 'image/png')]), 201)
  })

  it.each([
    ['a malformed document', svgBody({}, [element(`${SENTINEL}=`)])],
    ['an unknown media type', svgBody({}, [element(SVG_DATA, SENTINEL)])],
  ])('never embeds the payload of %s in a thrown message', async (_label, body) => {
    installFetch(() => jsonResponse(200, body))
    const run = await complete()
    const error = await failureOf(
      run(svgRequest({}, { parts: [{ type: 'text', text: SENTINEL }] })),
    )
    expect(ProviderError.is(error)).toBe(true)
    expect((error as Error).message).not.toContain(SENTINEL)
  })
})

describe('the svg response caps', () => {
  // The adapter states the §3 point 4c caps on its own side, every one read for the whole
  // response before any grammar scan: the core would reject the same answer, but only after
  // the transport had handed it over. Length-only strings keep these cheap: each oversized
  // case is rejected by a length read. The large bodies skip the JSON round trip, which is
  // the transport's work and not under test here: the adapter gets them already parsed.
  const AT_CAP = 'A'.repeat(10_000_000)
  const OVERSIZED = 'A'.repeat(10_000_004)

  /** Runs one svg request whose body arrives as `body` itself, with no fetch at all. */
  async function runParsed(body: unknown) {
    vi.mocked(fetchJson).mockResolvedValueOnce({ status: 200, body })
    const run = await complete()
    return run(svgRequest())
  }

  async function expectParsedMalformed(body: unknown): Promise<void> {
    const error = await failureOf(runParsed(body))
    expect(ProviderError.is(error) && error.kind === 'malformed_response').toBe(true)
  }

  it('reads sixteen documents', async () => {
    vi.mocked(isWireBase64).mockClear()
    const response = await runSvg(200, svgBody({}, elements(16)))
    expect(response.kind === 'complete' && response.svgs).toHaveLength(16)
    expect(isWireBase64).toHaveBeenCalledTimes(16)
  })

  /** `count` elements whose two fields count every read of them in `reads`. */
  function countedElements(count: number, reads: { count: number }) {
    return Array.from({ length: count }, () => ({
      get b64_json() {
        reads.count++
        return SVG_DATA
      },
      get media_type() {
        reads.count++
        return 'image/svg+xml'
      },
    }))
  }

  it('throws malformed_response for seventeen documents, before reading any of them', async () => {
    vi.mocked(isWireBase64).mockClear()
    const reads = { count: 0 }
    await expectParsedMalformed(svgBody({}, countedElements(17, reads)))
    expect(reads.count).toBe(0)
    expect(isWireBase64).not.toHaveBeenCalled()
    // The instrument counts: at the cap, every element's two fields are read.
    await runParsed(svgBody({}, countedElements(16, reads)))
    expect(reads.count).toBe(32)
  })

  it('reads a document whose data is exactly the per-document cap', async () => {
    const response = await runParsed(svgBody({}, [element(AT_CAP)]))
    expect(response.kind === 'complete' && response.svgs).toEqual([
      { mediaType: 'image/svg+xml', data: AT_CAP },
    ])
  })

  it('throws malformed_response on an over-long document, without running the grammar', async () => {
    // Grammatical, so only the cap can reject it.
    expect(OVERSIZED.length % 4).toBe(0)
    vi.mocked(isWireBase64).mockClear()
    await expectParsedMalformed(svgBody({}, [element(), element(OVERSIZED)]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })

  it('reads documents that together reach exactly the per-response cap', async () => {
    // The scan itself is not under test here: stubbed, it keeps four 10 MB strings cheap.
    // The calls are counted, so every document did reach it.
    const scan = vi.mocked(isWireBase64)
    scan.mockClear()
    for (let i = 0; i < 4; i++) scan.mockReturnValueOnce(true)
    try {
      const response = await runParsed(svgBody({}, elements(4, AT_CAP)))
      expect(response.kind === 'complete' && response.svgs).toHaveLength(4)
      expect(scan).toHaveBeenCalledTimes(4)
    } finally {
      // Drops any stub left unconsumed and restores the real scan for every later test.
      scan.mockReset()
    }
    expect(scan('AA A')).toBe(false)
  })

  it('throws malformed_response past the per-response cap, without running the grammar', async () => {
    vi.mocked(isWireBase64).mockClear()
    await expectParsedMalformed(svgBody({}, [element(), ...elements(4, AT_CAP)]))
    expect(isWireBase64).not.toHaveBeenCalled()
  })
})

describe('svg billing', () => {
  const COUNTS = { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175 }
  const USAGE = { inputTokens: 0, outputTokens: 4175 }

  it('reads the documented example answer: the document, its usage and its cost', async () => {
    const response = await runSvg(200, {
      created: 1_700_000_000,
      data: [element()],
      usage: { ...COUNTS, cost: 0.04 },
    })
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [{ mediaType: 'image/svg+xml', data: SVG_DATA }],
      usage: USAGE,
      costUsd: 0.04,
    })
  })

  it.each([
    ['absent', undefined],
    ['negative', -0.01],
    ['a string', '0.04'],
    ['null', null],
  ])('leaves costUsd out, not undefined, when usage.cost is %s', async (_label, cost) => {
    const usage: Record<string, unknown> = { ...COUNTS }
    if (cost !== undefined) usage.cost = cost
    const response = await runSvg(200, svgBody({ usage }))
    expect(response.usage).toEqual(USAGE)
    expect(Object.hasOwn(response, 'costUsd')).toBe(false)
  })

  it('never reports imageOutputTokens, even beside a breakdown', async () => {
    const response = await runSvg(
      200,
      svgBody({ usage: { ...COUNTS, completion_tokens_details: { image_tokens: 4175 } } }),
    )
    expect(response.usage).toEqual(USAGE)
    expect(response.usage).not.toHaveProperty('imageOutputTokens')
  })

  it('carries the cost when the counters are invalid and usage is null', async () => {
    const response = await runSvg(200, svgBody({ usage: { prompt_tokens: -1, cost: 0.04 } }))
    expect(response.usage).toBeNull()
    expect(response.costUsd).toBe(0.04)
  })

  it('carries usage and cost on a complete answer with no svgs', async () => {
    const response = await runSvg(200, svgBody({ usage: { ...COUNTS, cost: 0.04 } }, []))
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [],
      usage: USAGE,
      costUsd: 0.04,
    })
  })
})

describe('svg refusal and embedded errors', () => {
  const BILLED = { prompt_tokens: 10, completion_tokens: 0, cost: 0.001 }

  it('returns refused for an embedded moderation envelope, keeping usage and cost', async () => {
    const response = await runSvg(200, { ...MODERATION_METADATA_BODY, usage: BILLED })
    expect(response).toEqual({
      kind: 'refused',
      text: '',
      usage: { inputTokens: 10, outputTokens: 0 },
      costUsd: 0.001,
    })
  })

  it('throws an embedded error that is not moderation, with the HTTP status', async () => {
    const error = await failureOf(runSvg(200, { data: [], error: { type: 'credit' } }))
    expect(ProviderError.is(error) && error.kind === 'rate_limit').toBe(true)
    expect((error as ProviderError).status).toBe(200)
  })

  it.each([
    ['a moderation envelope', { error: { type: 'moderation' } }],
    ['a rate-limit word', { error: { metadata: { error_type: 'rate_limit_exceeded' } } }],
  ])('reads the documents beside %s as the answer', async (_label, extra) => {
    const response = await runSvg(200, { ...svgBody(), ...extra, usage: BILLED })
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [{ mediaType: 'image/svg+xml', data: SVG_DATA }],
      usage: { inputTokens: 10, outputTokens: 0 },
      costUsd: 0.001,
    })
  })

  it('holds documents beside an embedded error to every element rule', async () => {
    await expectMalformed(
      svgBody({ error: { type: 'moderation' } }, [element(PNG_DATA, 'image/png')]),
    )
    await expectMalformed(svgBody({ error: { type: 'moderation' } }, elements(17)))
  })

  it('classifies a 4xx to output_format svg by the shared rows, as invalid_request', async () => {
    // Scripted: a 400 rejecting the svg request. Only the status rows classify it.
    const error = await failureOf(
      runSvg(400, { error: { code: 400, message: 'output_format svg is not supported' } }),
    )
    expect(ProviderError.is(error) && error.kind === 'invalid_request').toBe(true)
    expect((error as ProviderError).status).toBe(400)
  })
})
