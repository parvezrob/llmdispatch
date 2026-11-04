/**
 * `openaiImages` driven through the core end to end (spec §3 point 4b, §5b, §7):
 * `createSwitch`, `run()`, the real adapter, and a scripted `fetch`. The adapter's own tests
 * dispatch to it directly; these show what an adopter receives once the core has read the
 * answer: the dimensioned image, the stated size held to the header, the zero-image
 * rejection, and how a rejected setting and a moderation block each end the run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createSwitch,
  defineOperation,
  defineOperations,
  imageOutputSchema,
  LLMDispatchError,
  memoryStores,
  openaiImages,
} from '../../../src/index'
import { expectCode } from '../core/helpers'
import { base64, png } from '../core/image-fixtures'
import {
  captureRequests,
  installFetch,
  jsonResponse,
  throwingGetter,
  withInherited,
} from './helpers'

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

/**
 * Error bodies the Images API was seen to answer, with the request id and the moderation
 * categories replaced. The first two are settings the model does not take; only the third is
 * a moderation block.
 */
const REJECTED_BACKGROUND = {
  error: {
    message: 'Transparent background is not supported for this model.',
    type: 'image_generation_user_error',
    param: 'background',
    code: 'invalid_value',
  },
}
const REJECTED_SIZE = {
  error: {
    message:
      "Invalid size '1536x864'. Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto.",
    type: 'image_generation_user_error',
    param: 'size',
    code: 'invalid_value',
  },
}
const MODERATION_BLOCKED = {
  error: {
    message:
      'Your request was rejected by the safety system. If you believe this is an error, ' +
      'contact us and include the request ID req_0000example.',
    type: 'image_generation_user_error',
    param: null,
    code: 'moderation_blocked',
    moderation_details: { moderation_stage: 'output', categories: ['example'] },
  },
}

/** The image operation again, with a fallback on a second key, to show what is terminal. */
function drawWithFallback() {
  const operations = defineOperations({
    draw: defineOperation({
      input: z.object({ subject: z.string() }),
      output: imageOutputSchema,
      prompt: ({ subject }) => `draw ${subject}`,
      format: 'image',
      image: { aspectRatio: '16:9', size: '1K', background: 'transparent' },
      defaultRoute: {
        provider: 'images',
        model: MODEL,
        fallback: { provider: 'spare', model: MODEL },
      },
    }),
  })
  return createSwitch({
    providers: {
      images: openaiImages({ apiKey: () => 'sk-images-test' }),
      spare: openaiImages({ apiKey: () => 'sk-images-spare' }),
    },
    operations,
    stores: memoryStores(),
  }).run('draw', { input: { subject: 'a fox' } })
}

describe('openaiImages error answers through run()', () => {
  it.each([
    ['an unsupported background', REJECTED_BACKGROUND],
    ['an unsupported size', REJECTED_SIZE],
  ])('ends %s as invalid_request with its status, not as a refusal', async (_label, body) => {
    const { fetch } = captureRequests(() => jsonResponse(400, body))
    const error = await expectCode(drawWithFallback(), 'PROVIDER_FAILED')

    expect(error.retryable).toBe(false)
    expect(error.message).toContain('invalid_request')
    expect(error.attempts).toEqual([
      expect.objectContaining({
        provider: 'images',
        outcome: 'invalid_request',
        status: 400,
        usage: null,
      }),
    ])
    // invalid_request does not fall back: the spare key is never called.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('ends a moderation block as refused, with no status and no fallback', async () => {
    const { fetch } = captureRequests(() => jsonResponse(400, MODERATION_BLOCKED))
    const error = await expectCode(drawWithFallback(), 'PROVIDER_FAILED')

    expect(error.retryable).toBe(false)
    expect(error.message).toContain('refused')
    expect(error.attempts).toHaveLength(1)
    const [attempt] = error.attempts ?? []
    expect(attempt).toEqual(
      expect.objectContaining({ provider: 'images', outcome: 'refused', usage: null }),
    )
    expect(attempt).not.toHaveProperty('status')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // An unclassified failure falls back under treatUnclassifiedAsTransient; a refusal never
  // does, so nothing a polluted prototype carries may turn one into the other.
  it('keeps a moderation block refused under a throwing inherited usage getter', async () => {
    const response = jsonResponse(400, { ...MODERATION_BLOCKED, usage: {} })
    const { fetch } = captureRequests(() => response)
    const ai = createSwitch({
      providers: {
        images: openaiImages({ apiKey: () => 'sk-images-test' }),
        spare: openaiImages({ apiKey: () => 'sk-images-spare' }),
      },
      operations: defineOperations({
        draw: defineOperation({
          input: z.object({}),
          output: imageOutputSchema,
          prompt: () => 'draw',
          format: 'image',
          defaultRoute: {
            provider: 'images',
            model: MODEL,
            fallback: { provider: 'spare', model: MODEL },
          },
        }),
      }),
      stores: memoryStores(),
      treatUnclassifiedAsTransient: true,
    })
    // The run happens under the pollution; the assertions after it, since a matcher reads
    // properties of its own.
    const outcome: unknown = await withInherited(
      Object.prototype,
      { input_tokens: throwingGetter() },
      () =>
        ai.run('draw', { input: {} }).then(
          () => null,
          (thrown: unknown) => thrown,
        ),
    )
    expect(outcome).toBeInstanceOf(LLMDispatchError)
    const error = outcome as LLMDispatchError
    expect(error.code).toBe('PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(error.attempts).toEqual([
      expect.objectContaining({ provider: 'images', outcome: 'refused', usage: null }),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the usage a moderation block reports, and prices it', async () => {
    installFetch(() =>
      jsonResponse(400, {
        ...MODERATION_BLOCKED,
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    )
    const error = await expectCode(draw(), 'PROVIDER_FAILED')
    expect(error.attempts).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: (10 * 5) / 1e6,
      }),
    ])
  })
})
