/**
 * Image output through `run()` (spec §3 point 4b, §6, §7): the definition's `image` block,
 * the request's `responseFormat`, normalization of every `ProviderImage` into a dimensioned,
 * frozen `GeneratedImage`, the zero-image rejection, the hostile `images` matrix, the
 * text-mode stray property, the provider-reported cost, and the exported schema.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LLMDispatchError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import { imageOutputSchema } from '../../../src/core/image-output'
import type {
  ImageOptions,
  OperationsMap,
  ProviderImage,
  ProviderResponse,
} from '../../../src/types'
import { base64, jpeg, png, providerImage } from './image-fixtures'
import {
  expectCode,
  fakeRuntime,
  fixture,
  scriptedProvider,
  scriptedStores,
  withThrowingGetter,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'
import type { FixtureOptions } from './helpers'

const INPUT = { input: { text: 'a fox' } }

function imageFixture(options: Omit<FixtureOptions, 'format' | 'output'> = {}) {
  return fixture({ ...options, format: 'image', output: imageOutputSchema })
}

function complete(
  images: unknown,
  extra: Partial<Record<'text' | 'usage' | 'costUsd', unknown>> = {},
): ProviderResponse {
  return {
    kind: 'complete',
    text: '',
    usage: { inputTokens: 10, outputTokens: 5 },
    images,
    ...extra,
  } as ProviderResponse
}

describe('the image block at createSwitch', () => {
  function build(definition: Record<string, unknown>): () => unknown {
    const s = scriptedStores()
    const p1 = scriptedProvider()
    return () =>
      createSwitchCore(
        {
          providers: { p1: p1.provider },
          operations: {
            echo: {
              input: ECHO_INPUT,
              output: imageOutputSchema,
              prompt: () => 'p',
              defaultRoute: { provider: 'p1', model: 'm1' },
              ...definition,
            },
          },
          stores: s.stores,
        },
        runtime,
      )
  }
  const runtime = fakeRuntime()

  const rejected: { name: string; definition: Record<string, unknown>; field: string }[] = [
    { name: 'an image block without image format', definition: { image: {} }, field: 'image' },
    {
      name: 'an image block on a text operation',
      definition: { format: 'text', image: { count: 2 } },
      field: 'image',
    },
    {
      name: 'a null image block',
      definition: { format: 'image', image: null },
      field: 'image',
    },
    {
      name: 'an image block that is an array',
      definition: { format: 'image', image: [] },
      field: 'image',
    },
    {
      name: 'an unknown image field',
      definition: { format: 'image', image: { quality: 'high' } },
      field: 'image.quality',
    },
    {
      name: 'count 0',
      definition: { format: 'image', image: { count: 0 } },
      field: 'image.count',
    },
    {
      name: 'count 11',
      definition: { format: 'image', image: { count: 11 } },
      field: 'image.count',
    },
    {
      name: 'a fractional count',
      definition: { format: 'image', image: { count: 1.5 } },
      field: 'image.count',
    },
    {
      name: 'a string count',
      definition: { format: 'image', image: { count: '2' } },
      field: 'image.count',
    },
    {
      name: 'an aspect ratio outside the seven',
      definition: { format: 'image', image: { aspectRatio: '5:4' } },
      field: 'image.aspectRatio',
    },
    {
      name: 'a non-string aspect ratio',
      definition: { format: 'image', image: { aspectRatio: 1 } },
      field: 'image.aspectRatio',
    },
    {
      name: 'a size outside the three',
      definition: { format: 'image', image: { size: '8K' } },
      field: 'image.size',
    },
    {
      name: 'a background outside the two',
      definition: { format: 'image', image: { background: 'blurred' } },
      field: 'image.background',
    },
  ]
  for (const { name, definition, field } of rejected) {
    it(`rejects ${name}, naming ${field}`, () => {
      let caught: unknown
      try {
        build(definition)()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LLMDispatchError)
      expect((caught as LLMDispatchError).code).toBe('INVALID_CONFIG')
      expect((caught as LLMDispatchError).message).toContain(field)
    })
  }

  it('accepts image format without a block, and every knob at its bounds', () => {
    expect(() => build({ format: 'image' })()).not.toThrow()
    expect(() =>
      build({
        format: 'image',
        image: { count: 1, aspectRatio: '1:1', size: '1K', background: 'transparent' },
      })(),
    ).not.toThrow()
    expect(() =>
      build({
        format: 'image',
        image: { count: 10, aspectRatio: '2:3', size: '4K', background: 'opaque' },
      })(),
    ).not.toThrow()
  })

  it('names the four formats when the format is unknown', () => {
    expect(() => build({ format: 'svg' })()).toThrow(/'image'/)
    expect(() => build({ format: 1 })()).toThrow(/'image'/)
  })

  it('reads format and imageOutputPerM once, so a getter cannot change them after validation', async () => {
    let formatReads = 0
    const definition = Object.defineProperty(
      {
        input: ECHO_INPUT,
        output: z.any(),
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
      'format',
      {
        enumerable: true,
        get: () => {
          formatReads += 1
          return formatReads === 1 ? 'image' : 'svg'
        },
      },
    )
    let rateReads = 0
    const price = Object.defineProperty({ inputPerM: 1, outputPerM: 1 }, 'imageOutputPerM', {
      enumerable: true,
      get: () => {
        rateReads += 1
        return rateReads === 1 ? 1 : -1_000_000
      },
    })
    const f = fixture({
      operations: { echo: definition } as unknown as OperationsMap,
      config: { pricing: { p1: { m1: price } } },
    })
    f.p1.nextResolve(
      complete([providerImage('image/png')], {
        usage: { inputTokens: 0, outputTokens: 1, imageOutputTokens: 1 },
      }),
    )
    const result = await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({ type: 'image' })
    expect(result.attempts[0]?.costUsd).toBeCloseTo(1 / 1e6, 15)
  })
})

describe('the request an image operation dispatches', () => {
  it('carries responseFormat.type image with only the knobs that were set', async () => {
    const f = imageFixture({ image: { count: 3, size: '2K' } })
    f.p1.nextResolve(complete([providerImage('image/png')]))
    await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({ type: 'image', count: 3, size: '2K' })
  })

  it('carries a bare image responseFormat when no block was given', async () => {
    const f = imageFixture()
    f.p1.nextResolve(complete([providerImage('image/png')]))
    await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({ type: 'image' })
  })

  it('dispatches the snapshot taken at createSwitch, whatever the definition does later', async () => {
    const image: ImageOptions = { count: 2, aspectRatio: '16:9' }
    const definition: Record<string, unknown> = {
      input: ECHO_INPUT,
      output: imageOutputSchema,
      prompt: () => 'p',
      format: 'image',
      image,
      defaultRoute: { provider: 'p1', model: 'm1' },
    }
    const f = fixture({ operations: { echo: definition } as unknown as OperationsMap })
    ;(image as { count?: number }).count = 9
    definition.format = 'json'
    definition.image = { size: '4K' }
    f.p1.nextResolve(complete([providerImage('image/png')]))
    const result = await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({
      type: 'image',
      count: 2,
      aspectRatio: '16:9',
    })
    expect((result.data as { images: unknown[] }).images).toHaveLength(1)
  })
})

describe('a complete image response', () => {
  it('hands the schema dimensioned, frozen images in order, with the text', async () => {
    const f = imageFixture()
    const stated: ProviderImage = {
      mediaType: 'image/jpeg',
      data: base64(jpeg(640, 480)),
      width: 640,
      height: 480,
    }
    f.p1.nextResolve(
      complete([providerImage('image/png', 2, 3), stated], { text: 'two foxes' }),
    )
    const result = await f.ai.run('echo', INPUT)
    const data = result.data as z.infer<typeof imageOutputSchema>
    expect(data.text).toBe('two foxes')
    expect(data.images).toEqual([
      { type: 'file', mediaType: 'image/png', data: base64(png(2, 3)), width: 2, height: 3 },
      {
        type: 'file',
        mediaType: 'image/jpeg',
        data: base64(jpeg(640, 480)),
        width: 640,
        height: 480,
      },
    ])
    expect(result.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
  })

  it('freezes the candidate and every image before the schema sees them', async () => {
    // `z.any()` answers the candidate itself, so what the schema was handed is observable.
    const f = fixture({ format: 'image', output: z.any() })
    f.p1.nextResolve(complete([providerImage('image/png'), providerImage('image/jpeg')]))
    const result = await f.ai.run('echo', INPUT)
    const data = result.data as { images: unknown[] }
    expect(Object.isFrozen(data)).toBe(true)
    expect(Object.isFrozen(data.images)).toBe(true)
    expect(data.images.every((image) => Object.isFrozen(image))).toBe(true)
  })

  it('reads a WebP the adapter left undimensioned', async () => {
    const f = imageFixture()
    f.p1.nextResolve(complete([providerImage('image/webp', 1024, 768)]))
    const result = await f.ai.run('echo', INPUT)
    const data = result.data as z.infer<typeof imageOutputSchema>
    expect(data.images[0]).toMatchObject({ mediaType: 'image/webp', width: 1024, height: 768 })
  })

  it('never hands image output to JSON.parse', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const f = imageFixture()
      f.p1.nextResolve(complete([providerImage('image/png')], { text: '{"not":"parsed"}' }))
      await f.ai.run('echo', INPUT)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('rejects zero images as output_rejected, fallback-eligible, like a parse failure', async () => {
    const f = imageFixture()
    f.p1.nextResolve(complete([]))
    f.p2.nextResolve(complete([providerImage('image/png')]))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['output_rejected', 'succeeded'])
  })

  it('treats absent images as zero images', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve({ kind: 'complete', text: 'no picture', usage: null })
    const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['output_rejected'])
  })

  it('runs the quality gate over { images, text } and rejects on ok false', async () => {
    const seen: unknown[] = []
    const f = imageFixture({
      quality: ({ data }) => {
        seen.push(data)
        return { ok: false, reason: 'too dark' }
      },
    })
    f.p1.nextResolve(complete([providerImage('image/png')], { text: 't' }))
    f.p2.nextResolve(complete([providerImage('image/png')], { text: 't' }))
    await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ text: 't', images: [{ width: 1, height: 1 }] })
  })

  it('lets the schema reject an image the adopter will not accept', async () => {
    const f = fixture({
      format: 'image',
      fallback: false,
      output: imageOutputSchema.refine((o) => o.images.every((i) => i.width >= 2)),
    })
    f.p1.nextResolve(complete([providerImage('image/png', 1, 1)]))
    await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
  })
})

describe('the hostile images matrix classifies malformed_response', () => {
  const valid = providerImage('image/png', 2, 3)
  const cases: { name: string; images: unknown }[] = [
    { name: 'a non-array', images: { length: 1 } },
    { name: 'a string', images: base64(png(1, 1)) },
    { name: 'a null element', images: [null] },
    { name: 'a string element', images: [valid.data] },
    { name: 'a mime outside the three', images: [{ ...valid, mediaType: 'image/gif' }] },
    { name: 'a non-string mime', images: [{ ...valid, mediaType: 1 }] },
    {
      name: 'data with a data-URL prefix',
      images: [{ ...valid, data: `data:image/png;base64,${valid.data}` }],
    },
    { name: 'data with whitespace', images: [{ ...valid, data: `${valid.data}\n` }] },
    { name: 'empty data', images: [{ ...valid, data: '' }] },
    { name: 'a width without a height', images: [{ ...valid, width: 2 }] },
    { name: 'a height without a width', images: [{ ...valid, height: 3 }] },
    {
      name: 'a width disagreeing with the header',
      images: [{ ...valid, width: 3, height: 3 }],
    },
    {
      name: 'a height disagreeing with the header',
      images: [{ ...valid, width: 2, height: 2 }],
    },
    { name: 'a fractional dimension', images: [{ ...valid, width: 2, height: 3.5 }] },
    { name: 'a negative dimension', images: [{ ...valid, width: -2, height: 3 }] },
    { name: 'an unreadable header', images: [{ mediaType: 'image/png', data: 'QUJDRA==' }] },
    {
      name: 'a mime that does not match the bytes',
      images: [{ ...valid, mediaType: 'image/jpeg' }],
    },
    {
      name: 'a valid image followed by a malformed one',
      images: [valid, { ...valid, mediaType: 'x' }],
    },
    { name: 'a throwing images getter', images: undefined, hostile: 'images' },
    {
      name: 'a throwing element getter',
      images: [withThrowingGetter({ mediaType: 'image/png' }, 'data')],
    },
  ] as { name: string; images: unknown; hostile?: string }[]

  for (const { name, images, hostile } of cases as {
    name: string
    images: unknown
    hostile?: string
  }[]) {
    it(`classifies ${name}`, async () => {
      const f = imageFixture({ fallback: false })
      const response =
        hostile === 'images'
          ? withThrowingGetter({ kind: 'complete', text: '', usage: null }, 'images')
          : complete(images)
      f.p1.nextResolve(response as ProviderResponse)
      const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
      expect(error.attempts?.map((a) => a.outcome)).toEqual(['malformed_response'])
    })
  }

  it('reads by index, so a poisoned iterator on the images array changes nothing', async () => {
    const images = [providerImage('image/png', 2, 3)] as unknown as Record<symbol, unknown>
    images[Symbol.iterator] = () => {
      throw new Error('iterated')
    }
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete(images))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as { images: { width: number }[] }).images[0]?.width).toBe(2)
  })

  it('keeps the first answer of a getter that changes its mind', async () => {
    let reads = 0
    const image = Object.defineProperty({ mediaType: 'image/png' }, 'data', {
      enumerable: true,
      get: () => {
        reads += 1
        if (reads === 1) return valid.data
        throw new Error('second read')
      },
    })
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete([image]))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as { images: { width: number }[] }).images[0]?.width).toBe(2)
    expect(reads).toBe(1)
  })
})

describe('the response-side caps (spec §3 point 4b)', () => {
  /** A PNG whose header is real, padded with zero bytes to exactly `characters` base64. */
  function paddedPng(characters: number): string {
    const bytes = Buffer.alloc((characters / 4) * 3)
    Buffer.from(png(4, 5)).copy(bytes)
    return bytes.toString('base64')
  }

  function copies(count: number): ProviderImage[] {
    return Array.from({ length: count }, () => providerImage('image/png', 2, 3))
  }

  it('accepts ten images', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete(copies(10)))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as z.infer<typeof imageOutputSchema>).images).toHaveLength(10)
  })

  it('classifies an eleventh image as malformed_response', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete(copies(11)))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['malformed_response'])
  })

  // The cap is read off the length alone, before the grammar scan and before the header
  // reader: this string would fail both, and the classification is the same either way.
  it('classifies data over the per-image cap as malformed_response', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete([{ mediaType: 'image/png', data: `${paddedPng(30_000_000)}A` }]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['malformed_response'])
  })

  it('leaves data of exactly the cap to the grammar and the header reader', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(complete([{ mediaType: 'image/png', data: paddedPng(30_000_000) }]))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as z.infer<typeof imageOutputSchema>).images[0]).toMatchObject({
      width: 4,
      height: 5,
    })
  })
})

describe('images outside image format', () => {
  it('is never read on a json operation, even when reading it would throw', async () => {
    const f = fixture()
    f.p1.nextResolve(
      withThrowingGetter(
        { kind: 'complete', text: '{"answer":"ok"}', usage: null },
        'images',
      ) as unknown as ProviderResponse,
    )
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toEqual({ answer: 'ok' })
  })

  it('is never read on a text operation', async () => {
    const f = fixture({ format: 'text', output: z.string() })
    f.p1.nextResolve({
      kind: 'complete',
      text: 'plain',
      usage: null,
      images: 'garbage',
    } as never)
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toBe('plain')
  })
})

describe('a provider-reported cost (spec §7)', () => {
  const PRICING = {
    pricing: {
      p1: { m1: { inputPerM: 1000, outputPerM: 2000, imageOutputPerM: 40_000 } },
      p2: { m2: { inputPerM: 500, outputPerM: 500, imageOutputPerM: 30_000 } },
    },
  }

  it('beats the pricing table on a succeeded attempt', async () => {
    const f = imageFixture({ config: PRICING })
    f.p1.nextResolve(
      complete([providerImage('image/png')], {
        usage: { inputTokens: 10, outputTokens: 5, imageOutputTokens: 5 },
        costUsd: 0.04,
      }),
    )
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts[0]?.costUsd).toBe(0.04)
    expect(result.cost).toBe(0.04)
  })

  it('is read on truncated, refused, malformed and rejected attempts too', async () => {
    const kinds: ProviderResponse[] = [
      { kind: 'truncated', text: '', usage: null, costUsd: 0.01 },
      { kind: 'refused', text: '', usage: null, costUsd: 0.02 },
      { kind: 'bogus', text: '', usage: null, costUsd: 0.03 } as unknown as ProviderResponse,
      complete([], { costUsd: 0.05 }),
      complete([{ mediaType: 'image/png', data: 'AAAA' }], { costUsd: 0.06 }),
    ]
    for (const response of kinds) {
      const f = imageFixture({ config: PRICING, fallback: false })
      f.p1.nextResolve(response)
      let attempts: readonly { costUsd: number | null }[] | undefined
      try {
        await f.ai.run('echo', INPUT)
      } catch (error) {
        attempts = (error as LLMDispatchError).attempts
      }
      expect(attempts?.[0]?.costUsd).toBe(response.costUsd)
    }
  })

  it('falls back to the table when the reported value is not a finite non-negative number', async () => {
    for (const costUsd of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '0.04', null, {}]) {
      const f = imageFixture({ config: PRICING })
      f.p1.nextResolve(
        complete([providerImage('image/png')], {
          usage: { inputTokens: 10, outputTokens: 5, imageOutputTokens: 5 },
          costUsd,
        }),
      )
      const result = await f.ai.run('echo', INPUT)
      expect(result.attempts[0]?.costUsd).toBeCloseTo(
        (10 * 1000) / 1e6 + (5 * 40_000) / 1e6,
        12,
      )
    }
  })

  it('accepts a reported zero', async () => {
    const f = imageFixture({ config: PRICING })
    f.p1.nextResolve(complete([providerImage('image/png')], { costUsd: 0 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts[0]?.costUsd).toBe(0)
  })

  it('keeps the usage and cost already read when a later property throws', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(
      withThrowingGetter(
        {
          kind: 'complete',
          usage: { inputTokens: 1, outputTokens: 0 },
          costUsd: 0.25,
          images: [],
        },
        'text',
      ) as unknown as ProviderResponse,
    )
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.[0]).toMatchObject({
      outcome: 'malformed_response',
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 0.25,
    })
  })

  it('classifies a throwing costUsd getter as malformed like any other hostile property', async () => {
    const f = imageFixture({ fallback: false })
    f.p1.nextResolve(
      withThrowingGetter(
        { kind: 'complete', text: '', usage: null, images: [providerImage('image/png')] },
        'costUsd',
      ) as unknown as ProviderResponse,
    )
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.[0]?.outcome).toBe('malformed_response')
  })

  it('sums a reported primary cost with a table-priced fallback', async () => {
    const f = imageFixture({ config: PRICING })
    f.p1.nextResolve(complete([], { costUsd: 0.05, usage: null }))
    f.p2.nextResolve(
      complete([providerImage('image/png')], {
        usage: { inputTokens: 10, outputTokens: 4, imageOutputTokens: 4 },
      }),
    )
    const result = await f.ai.run('echo', INPUT)
    const fallbackCost = (10 * 500) / 1e6 + (4 * 30_000) / 1e6
    expect(result.cost).toBeCloseTo(0.05 + fallbackCost, 12)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, imageOutputTokens: 4 })
    expect(result.usageComplete).toBe(false)
  })
})

describe('imageOutputSchema', () => {
  it('accepts a dimensioned image list with text and rejects an empty one', () => {
    const image = { type: 'file', mediaType: 'image/png', data: 'AAAA', width: 1, height: 1 }
    expect(imageOutputSchema.safeParse({ images: [image], text: '' }).success).toBe(true)
    expect(imageOutputSchema.safeParse({ images: [], text: '' }).success).toBe(false)
    expect(
      imageOutputSchema.safeParse({ images: [{ ...image, width: 0 }], text: '' }).success,
    ).toBe(false)
    expect(
      imageOutputSchema.safeParse({ images: [{ ...image, type: 'text' }], text: '' }).success,
    ).toBe(false)
    expect(imageOutputSchema.safeParse({ images: [image] }).success).toBe(false)
  })

  it('is what a json operation cannot satisfy: the echo output stays the echo output', () => {
    expect(ECHO_OUTPUT.safeParse({ images: [], text: '' }).success).toBe(false)
  })
})
