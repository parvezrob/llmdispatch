/**
 * `openrouterImages` driven through the core end to end (spec §3 points 4b and 4c, §5b, §7):
 * `createSwitch`, `run()`, the real adapter, and a scripted `fetch`. The adapter's own tests
 * dispatch to it directly; these show what an adopter receives once the core has read the
 * answer: the dimensioned image or the checked SVG document, the reported cost taking the
 * place of the table price, what an attempt costs when the answer reports none, and which
 * svg failures fall back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createSwitch,
  defineOperation,
  defineOperations,
  imageOutputSchema,
  memoryStores,
  openrouterImages,
  svgOutputSchema,
} from '../../../src/index'
import { expectCode } from '../core/helpers'
import { base64, png } from '../core/image-fixtures'
import { captureRequests, installFetch, jsonResponse } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const MODEL = 'bytedance-seed/seedream-x'

/** A 2x3 PNG header: what the core's header reader measures. */
const PNG_DATA = base64(png(2, 3))

/** Priced by provider ID and model (§7); the table knows no image split for this wire. */
const PRICE = { inputPerM: 5, outputPerM: 10, imageOutputPerM: 40 }

/** One image operation routed to the real adapter. */
function imagesSwitch() {
  const operations = defineOperations({
    draw: defineOperation({
      input: z.object({ subject: z.string() }),
      output: imageOutputSchema,
      prompt: ({ subject }) => `draw ${subject}`,
      format: 'image',
      image: { size: '1K' },
      defaultRoute: { provider: 'router', model: MODEL },
    }),
  })
  return createSwitch({
    providers: { router: openrouterImages({ apiKey: () => 'sk-or-test' }) },
    operations,
    stores: memoryStores(),
    pricing: { router: { [MODEL]: PRICE } },
  })
}

function draw() {
  return imagesSwitch().run('draw', { input: { subject: 'a fox' } })
}

function answer(usage: Record<string, unknown>, mediaType = 'image/png') {
  return { data: [{ b64_json: PNG_DATA, media_type: mediaType }], usage }
}

describe('openrouterImages through run()', () => {
  it('hands the adopter a dimensioned image, priced at the reported cost', async () => {
    const { requests } = captureRequests(() =>
      jsonResponse(200, answer({ prompt_tokens: 10, completion_tokens: 1200, cost: 0.0406 })),
    )
    const result = await draw()

    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/images')
    expect(requests[0]!.body).toEqual({ model: MODEL, prompt: 'draw a fox', resolution: '1K' })
    expect(result.data).toEqual({
      images: [{ type: 'file', mediaType: 'image/png', data: PNG_DATA, width: 2, height: 3 }],
      text: '',
    })
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: 'router',
        model: MODEL,
        outcome: 'succeeded',
        usage: { inputTokens: 10, outputTokens: 1200 },
        costUsd: 0.0406,
      }),
    ])
    // With no image split the table would price this attempt null (§7); the reported
    // charge is what prices it.
    expect(result.cost).toBe(0.0406)
  })

  it('takes the reported cost over a table price that disagrees', async () => {
    // No output tokens, so the table alone would price the input: 10 at 5 per million.
    installFetch(() =>
      jsonResponse(200, answer({ prompt_tokens: 10, completion_tokens: 0, cost: 0.04 })),
    )
    const result = await draw()
    expect(result.attempts).toEqual([expect.objectContaining({ costUsd: 0.04 })])
    expect(result.cost).toBe(0.04)
  })

  it('prices a non-zero output without a reported cost as null (§7)', async () => {
    installFetch(() =>
      jsonResponse(200, answer({ prompt_tokens: 10, completion_tokens: 1200 })),
    )
    const result = await draw()
    expect(result.attempts).toEqual([
      expect.objectContaining({
        outcome: 'succeeded',
        usage: { inputTokens: 10, outputTokens: 1200 },
        costUsd: null,
      }),
    ])
    expect(result.cost).toBeNull()
  })

  it('prices from the table when the answer reports no cost and no output tokens', async () => {
    installFetch(() => jsonResponse(200, answer({ prompt_tokens: 10, completion_tokens: 0 })))
    const result = await draw()
    expect(result.attempts).toEqual([
      expect.objectContaining({ costUsd: (10 * PRICE.inputPerM) / 1e6 }),
    ])
    expect(result.cost).toBeCloseTo((10 * 5) / 1e6, 12)
  })

  it('treats an invalid reported cost as absent, so the table rule applies', async () => {
    installFetch(() =>
      jsonResponse(200, answer({ prompt_tokens: 10, completion_tokens: 1200, cost: -1 })),
    )
    const result = await draw()
    expect(result.attempts).toEqual([expect.objectContaining({ costUsd: null })])
    expect(result.cost).toBeNull()
  })

  it('ends an SVG answer as malformed_response, retryable, with no usage or cost', async () => {
    // The adapter throws, and a thrown classification carries no billing: the answer's
    // usage and reported charge do not reach the attempt record.
    installFetch(() =>
      jsonResponse(
        200,
        answer({ prompt_tokens: 10, completion_tokens: 1200, cost: 0.04 }, 'image/svg+xml'),
      ),
    )
    const error = await expectCode(draw(), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.attempts).toEqual([
      expect.objectContaining({
        outcome: 'malformed_response',
        status: 200,
        usage: null,
        costUsd: null,
      }),
    ])
  })

  it('records empty data as the output rejection, keeping usage and the reported cost', async () => {
    installFetch(() =>
      jsonResponse(200, {
        data: [],
        usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.001 },
      }),
    )
    const error = await expectCode(draw(), 'OUTPUT_REJECTED')
    expect(error.attempts).toEqual([
      expect.objectContaining({
        outcome: 'output_rejected',
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.001,
      }),
    ])
  })

  it('ends an embedded moderation envelope as refused, keeping usage and the reported cost', async () => {
    installFetch(() =>
      jsonResponse(200, {
        error: { metadata: { error_type: 'moderation' } },
        usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.002 },
      }),
    )
    const error = await expectCode(draw(), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(error.attempts).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.002,
      }),
    ])
  })

  it('hands over the images a 2xx carries beside an embedded error, at the reported cost', async () => {
    installFetch(() =>
      jsonResponse(200, {
        ...answer({ prompt_tokens: 10, completion_tokens: 1200, cost: 0.0406 }),
        error: { metadata: { error_type: 'moderation' } },
      }),
    )
    const result = await draw()
    expect(result.data.images).toHaveLength(1)
    expect(result.attempts).toEqual([
      expect.objectContaining({ outcome: 'succeeded', costUsd: 0.0406 }),
    ])
    expect(result.cost).toBe(0.0406)
  })
})

const VECTOR_MODEL = 'recraft/recraft-vector-x'
const FALLBACK_MODEL = 'recraft/recraft-vector-y'

/** A document's UTF-8 bytes as base64, the way the Image API carries it in `b64_json`. */
function svgData(markup: string): string {
  return Buffer.from(markup, 'utf8').toString('base64')
}

const SVG_DATA = svgData('<svg><rect/></svg>')
const FALLBACK_SVG = svgData('<svg><circle/></svg>')

/** One svg operation routed to the real adapter, with a fallback to a second vector model. */
function svgSwitch() {
  const operations = defineOperations({
    trace: defineOperation({
      input: z.object({ subject: z.string() }),
      output: svgOutputSchema,
      prompt: ({ subject }) => `trace ${subject}`,
      format: 'svg',
      svg: { aspectRatio: '1:1' },
      defaultRoute: {
        provider: 'router',
        model: VECTOR_MODEL,
        fallback: { provider: 'router', model: FALLBACK_MODEL },
      },
    }),
  })
  return createSwitch({
    providers: { router: openrouterImages({ apiKey: () => 'sk-or-test' }) },
    operations,
    stores: memoryStores(),
    pricing: {
      router: { [VECTOR_MODEL]: PRICE, [FALLBACK_MODEL]: PRICE },
    },
  })
}

function trace() {
  return svgSwitch().run('trace', { input: { subject: 'a fox' } })
}

function svgAnswer(
  usage: Record<string, unknown>,
  data = SVG_DATA,
  mediaType = 'image/svg+xml',
) {
  return { data: [{ b64_json: data, media_type: mediaType }], usage }
}

/** Answers the primary model with `primary` and the fallback model with one good document. */
function byModel(primary: () => Response) {
  return captureRequests((_url, init) => {
    const body = JSON.parse(init.body as string) as { model: string }
    if (body.model === VECTOR_MODEL) return primary()
    return jsonResponse(
      200,
      svgAnswer({ prompt_tokens: 0, completion_tokens: 0, cost: 0.08 }, FALLBACK_SVG),
    )
  })
}

describe('openrouterImages svg output through run()', () => {
  it('hands the adopter the provider base64 unchanged, priced at the reported cost', async () => {
    const { requests } = captureRequests(() =>
      jsonResponse(200, svgAnswer({ prompt_tokens: 0, completion_tokens: 4175, cost: 0.04 })),
    )
    const result = await trace()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/images')
    expect(requests[0]!.body).toEqual({
      model: VECTOR_MODEL,
      prompt: 'trace a fox',
      output_format: 'svg',
      aspect_ratio: '1:1',
    })
    expect(result.data).toEqual({
      svgs: [{ type: 'svg', mediaType: 'image/svg+xml', data: SVG_DATA }],
      text: '',
    })
    expect(result.data).not.toHaveProperty('images')
    expect(result.usedFallback).toBe(false)
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: 'router',
        model: VECTOR_MODEL,
        outcome: 'succeeded',
        usage: { inputTokens: 0, outputTokens: 4175 },
        costUsd: 0.04,
      }),
    ])
    expect(result.cost).toBe(0.04)
  })

  it('ends a raster answer to an svg request as malformed_response, and falls back', async () => {
    const { requests } = byModel(() =>
      jsonResponse(
        200,
        svgAnswer(
          { prompt_tokens: 0, completion_tokens: 1200, cost: 0.04 },
          PNG_DATA,
          'image/png',
        ),
      ),
    )
    const result = await trace()
    expect(requests.map((request) => (request.body as { model: string }).model)).toEqual([
      VECTOR_MODEL,
      FALLBACK_MODEL,
    ])
    expect(result.usedFallback).toBe(true)
    expect(result.data.svgs).toEqual([
      { type: 'svg', mediaType: 'image/svg+xml', data: FALLBACK_SVG },
    ])
    expect(result.attempts).toEqual([
      expect.objectContaining({
        model: VECTOR_MODEL,
        outcome: 'malformed_response',
        status: 200,
      }),
      expect.objectContaining({ model: FALLBACK_MODEL, outcome: 'succeeded', costUsd: 0.08 }),
    ])
  })

  it('ends a document with a DOCTYPE as malformed_response in the core, keeping usage and cost', async () => {
    // The adapter takes any grammatical base64 labelled image/svg+xml; the core's document
    // check refuses it, after the attempt's billing has been read.
    const doctype = svgData('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')
    const { requests } = byModel(() =>
      jsonResponse(
        200,
        svgAnswer({ prompt_tokens: 0, completion_tokens: 4175, cost: 0.04 }, doctype),
      ),
    )
    const result = await trace()
    expect(requests).toHaveLength(2)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toEqual([
      expect.objectContaining({
        model: VECTOR_MODEL,
        outcome: 'malformed_response',
        usage: { inputTokens: 0, outputTokens: 4175 },
        costUsd: 0.04,
      }),
      expect.objectContaining({ model: FALLBACK_MODEL, outcome: 'succeeded' }),
    ])
  })

  it.each([
    ['a non-zero output', 4175],
    ['no output tokens', 0],
  ])(
    'prices an attempt with no reported cost and no image split as null, with %s (§7)',
    async (_label, completionTokens) => {
      installFetch(() =>
        jsonResponse(
          200,
          svgAnswer({ prompt_tokens: 10, completion_tokens: completionTokens }),
        ),
      )
      const result = await trace()
      expect(result.attempts).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          usage: { inputTokens: 10, outputTokens: completionTokens },
          costUsd: null,
        }),
      ])
      expect(result.cost).toBeNull()
    },
  )

  it('ends a 4xx to output_format svg as invalid_request, with no fallback', async () => {
    // Scripted: a 400 rejecting the svg request. It is classified by the status rows, never
    // remapped, so the configured fallback is not tried.
    const { requests } = byModel(() =>
      jsonResponse(400, { error: { code: 400, message: 'unsupported output_format' } }),
    )
    const error = await expectCode(trace(), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(requests).toHaveLength(1)
    expect(error.attempts).toEqual([
      expect.objectContaining({ model: VECTOR_MODEL, outcome: 'invalid_request', status: 400 }),
    ])
  })
})
