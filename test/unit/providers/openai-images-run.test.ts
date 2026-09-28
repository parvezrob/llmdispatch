/**
 * `openaiImages` driven through the core end to end (spec §3 point 4b, §5b, §7):
 * `createSwitch`, `run()`, the real adapter, and a scripted `fetch`. The adapter's own tests
 * dispatch to it directly; these show what an adopter receives once the core has read the
 * answer: the dimensioned image, the stated size held to the header, and the zero-image
 * rejection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createSwitch,
  defineOperation,
  defineOperations,
  imageOutputSchema,
  memoryStores,
  openaiImages,
} from '../../../src/index'
import { expectCode } from '../core/helpers'
import { base64, png } from '../core/image-fixtures'
import { captureRequests, installFetch, jsonResponse } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const MODEL = 'gpt-image-x'

/** A 2x3 PNG header: what the core's header reader measures every stated size against. */
const PNG_DATA = base64(png(2, 3))

const WIRE_USAGE = {
  input_tokens: 10,
  output_tokens: 1200,
  output_tokens_details: { image_tokens: 1100 },
}
const USAGE = { inputTokens: 10, outputTokens: 1200, imageOutputTokens: 1100 }

/** One image operation routed to the real adapter, priced by provider ID and model (§7). */
function imagesSwitch() {
  const operations = defineOperations({
    draw: defineOperation({
      input: z.object({ subject: z.string() }),
      output: imageOutputSchema,
      prompt: ({ subject }) => `draw ${subject}`,
      format: 'image',
      defaultRoute: { provider: 'images', model: MODEL },
    }),
  })
  return createSwitch({
    providers: { images: openaiImages({ apiKey: () => 'sk-images-test' }) },
    operations,
    stores: memoryStores(),
    pricing: { images: { [MODEL]: { inputPerM: 5, outputPerM: 10, imageOutputPerM: 40 } } },
  })
}

function draw() {
  return imagesSwitch().run('draw', { input: { subject: 'a fox' } })
}

describe('openaiImages through run()', () => {
  it('hands the adopter a dimensioned image and prices the image tokens', async () => {
    const { requests } = captureRequests(() =>
      jsonResponse(200, {
        created: 1,
        size: '2x3',
        data: [{ b64_json: PNG_DATA }],
        usage: WIRE_USAGE,
      }),
    )
    const result = await draw()

    expect(requests[0]!.body).toEqual({ model: MODEL, prompt: 'draw a fox' })
    expect(result.data).toEqual({
      images: [{ type: 'file', mediaType: 'image/png', data: PNG_DATA, width: 2, height: 3 }],
      text: '',
    })
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: 'images',
        model: MODEL,
        outcome: 'succeeded',
        usage: USAGE,
      }),
    ])
    expect(result.usage).toEqual(USAGE)
    // 10 input tokens at 5, the 100 text tokens at 10, the 1100 image tokens at 40, per million.
    expect(result.cost).toBeCloseTo((10 * 5 + 100 * 10 + 1100 * 40) / 1e6, 12)
  })

  it('ends a stated size that disagrees with the header as malformed_response, keeping usage', async () => {
    installFetch(() =>
      jsonResponse(200, { size: '3x2', data: [{ b64_json: PNG_DATA }], usage: WIRE_USAGE }),
    )
    const error = await expectCode(draw(), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.attempts).toEqual([
      expect.objectContaining({ outcome: 'malformed_response', usage: USAGE }),
    ])
  })

  it('records empty data as the output rejection', async () => {
    installFetch(() =>
      jsonResponse(200, { data: [], usage: { input_tokens: 10, output_tokens: 0 } }),
    )
    const error = await expectCode(draw(), 'OUTPUT_REJECTED')
    expect(error.attempts).toEqual([
      expect.objectContaining({
        outcome: 'output_rejected',
        usage: { inputTokens: 10, outputTokens: 0 },
      }),
    ])
  })
})
