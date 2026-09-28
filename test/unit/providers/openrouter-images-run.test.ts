/**
 * `openrouterImages` driven through the core end to end (spec §3 point 4b, §5b, §7):
 * `createSwitch`, `run()`, the real adapter, and a scripted `fetch`. The adapter's own tests
 * dispatch to it directly; these show what an adopter receives once the core has read the
 * answer: the dimensioned image, the reported cost taking the place of the table price, and
 * what an attempt costs when the answer reports none.
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
})
