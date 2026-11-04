/**
 * SVG output through `run()` (spec §3 point 4c, §6, §7): the definition's `svg` block, the
 * request's `responseFormat`, normalization of every `ProviderSvg` into a frozen
 * `GeneratedSvg`, the zero-svg rejection, the hostile `svgs` matrix, the three caps before
 * any decode, the stray media fields on the other formats, the pricing rule, and the
 * exported schema.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LLMDispatchError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import { imageOutputSchema } from '../../../src/core/image-output'
import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
  svgDocumentProblem,
} from '../../../src/core/svg-document'
import type * as svgDocumentModule from '../../../src/core/svg-document'
import { svgOutputSchema } from '../../../src/core/svg-output'
import type {
  OperationsMap,
  ProviderResponse,
  ProviderSvg,
  SvgOptions,
} from '../../../src/types'
import { providerImage } from './image-fixtures'
import {
  expectCode,
  fakeRuntime,
  fixture,
  scriptedProvider,
  scriptedStores,
  withThrowingGetter,
  ECHO_INPUT,
} from './helpers'
import type { FixtureOptions } from './helpers'

// The real check, made observable, so the cap tests can show it is never reached.
vi.mock('../../../src/core/svg-document', async (importOriginal) => {
  const actual = await importOriginal<typeof svgDocumentModule>()
  return { ...actual, svgDocumentProblem: vi.fn(actual.svgDocumentProblem) }
})

const INPUT = { input: { text: 'a fox' } }

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function providerSvg(markup = '<svg/>'): ProviderSvg {
  return { mediaType: 'image/svg+xml', data: b64(markup) }
}

/** A valid document padded with spaces inside the root to exactly `characters` of base64. */
function paddedSvg(characters: number): string {
  const bytes = (characters / 4) * 3
  return b64('<svg>'.padEnd(bytes, ' '))
}

function svgFixture(options: Omit<FixtureOptions, 'format' | 'output'> = {}) {
  return fixture({ ...options, format: 'svg', output: svgOutputSchema })
}

function complete(
  svgs: unknown,
  extra: Partial<Record<'text' | 'usage' | 'costUsd' | 'images', unknown>> = {},
): ProviderResponse {
  return {
    kind: 'complete',
    text: '',
    usage: { inputTokens: 10, outputTokens: 5 },
    svgs,
    ...extra,
  } as ProviderResponse
}

async function expectMalformed(f: ReturnType<typeof svgFixture>): Promise<void> {
  const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
  expect(error.attempts?.map((a) => a.outcome)).toEqual(['malformed_response'])
}

describe('the svg block at createSwitch', () => {
  const runtime = fakeRuntime()
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
              output: svgOutputSchema,
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

  const rejected: { name: string; definition: Record<string, unknown>; message: string }[] = [
    {
      name: 'an svg block without svg format',
      definition: { svg: {} },
      message: "svg is only allowed when format is 'svg'",
    },
    {
      name: 'an svg block on an image operation',
      definition: { format: 'image', svg: { count: 2 } },
      message: "svg is only allowed when format is 'svg'",
    },
    {
      name: 'an image block on an svg operation',
      definition: { format: 'svg', image: { count: 2 } },
      message: "image is only allowed when format is 'image'",
    },
    {
      name: 'a null svg block',
      definition: { format: 'svg', svg: null },
      message: 'svg must be an object',
    },
    {
      name: 'an svg block that is an array',
      definition: { format: 'svg', svg: [] },
      message: 'svg must be an object',
    },
    {
      name: 'a size, which a vector does not have',
      definition: { format: 'svg', svg: { size: '1K' } },
      message: 'svg.size is not a known field',
    },
    {
      name: 'a background',
      definition: { format: 'svg', svg: { background: 'transparent' } },
      message: 'svg.background is not a known field',
    },
    { name: 'count 0', definition: { format: 'svg', svg: { count: 0 } }, message: 'svg.count' },
    {
      name: 'count 11',
      definition: { format: 'svg', svg: { count: 11 } },
      message: 'svg.count',
    },
    {
      name: 'a fractional count',
      definition: { format: 'svg', svg: { count: 1.5 } },
      message: 'svg.count',
    },
    {
      name: 'a string count',
      definition: { format: 'svg', svg: { count: '2' } },
      message: 'svg.count',
    },
    {
      name: "the aspect ratio 'auto'",
      definition: { format: 'svg', svg: { aspectRatio: 'auto' } },
      message: 'svg.aspectRatio',
    },
    {
      name: 'a non-string aspect ratio',
      definition: { format: 'svg', svg: { aspectRatio: 1 } },
      message: 'svg.aspectRatio',
    },
  ]
  for (const { name, definition, message } of rejected) {
    it(`rejects ${name}`, () => {
      let caught: unknown
      try {
        build(definition)()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LLMDispatchError)
      expect((caught as LLMDispatchError).code).toBe('INVALID_CONFIG')
      expect((caught as LLMDispatchError).message).toContain(message)
    })
  }

  it('accepts svg format without a block, and both knobs at their bounds', () => {
    expect(() => build({ format: 'svg' })()).not.toThrow()
    expect(() =>
      build({ format: 'svg', svg: { count: 1, aspectRatio: '1:1' } })(),
    ).not.toThrow()
    expect(() =>
      build({ format: 'svg', svg: { count: 10, aspectRatio: '2:3' } })(),
    ).not.toThrow()
  })
})

describe('the request an svg operation dispatches', () => {
  it('carries responseFormat.type svg with only the knobs that were set', async () => {
    const f = svgFixture({ svg: { aspectRatio: '4:3' } })
    f.p1.nextResolve(complete([providerSvg()]))
    await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({ type: 'svg', aspectRatio: '4:3' })
  })

  it('carries a bare svg responseFormat when no block was given', async () => {
    const f = svgFixture()
    f.p1.nextResolve(complete([providerSvg()]))
    await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({ type: 'svg' })
  })

  it('dispatches the snapshot taken at createSwitch, whatever the definition does later', async () => {
    const svg: SvgOptions = { count: 2, aspectRatio: '16:9' }
    const definition: Record<string, unknown> = {
      input: ECHO_INPUT,
      output: svgOutputSchema,
      prompt: () => 'p',
      format: 'svg',
      svg,
      defaultRoute: { provider: 'p1', model: 'm1' },
    }
    const f = fixture({ operations: { echo: definition } as unknown as OperationsMap })
    ;(svg as { count?: number }).count = 9
    definition.format = 'json'
    definition.svg = { aspectRatio: '1:1' }
    f.p1.nextResolve(complete([providerSvg()]))
    const result = await f.ai.run('echo', INPUT)
    expect(f.p1.requests[0]?.responseFormat).toEqual({
      type: 'svg',
      count: 2,
      aspectRatio: '16:9',
    })
    expect((result.data as { svgs: unknown[] }).svgs).toHaveLength(1)
  })
})

describe('a complete svg response', () => {
  it('hands the schema frozen documents in order, the provider base64 unchanged', async () => {
    const f = svgFixture()
    const first = providerSvg('<?xml version="1.0"?><svg><circle r="1"/></svg>')
    const second = providerSvg('﻿<!-- art --><svg/>')
    f.p1.nextResolve(complete([first, second], { text: 'two foxes' }))
    const result = await f.ai.run('echo', INPUT)
    const data = result.data as z.infer<typeof svgOutputSchema>
    expect(data).toEqual({
      text: 'two foxes',
      svgs: [
        { type: 'svg', mediaType: 'image/svg+xml', data: first.data },
        { type: 'svg', mediaType: 'image/svg+xml', data: second.data },
      ],
    })
    expect(result.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
  })

  it('freezes the candidate and every document before the schema sees them', async () => {
    const f = fixture({ format: 'svg', output: z.any() })
    f.p1.nextResolve(complete([providerSvg(), providerSvg('<svg>')]))
    const result = await f.ai.run('echo', INPUT)
    const data = result.data as { svgs: unknown[] }
    expect(Object.isFrozen(data)).toBe(true)
    expect(Object.isFrozen(data.svgs)).toBe(true)
    expect(data.svgs.every((svg) => Object.isFrozen(svg))).toBe(true)
  })

  it('never hands svg output to JSON.parse', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const f = svgFixture()
      f.p1.nextResolve(complete([providerSvg()], { text: '{"not":"parsed"}' }))
      await f.ai.run('echo', INPUT)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('rejects zero svgs as output_rejected, fallback-eligible', async () => {
    const f = svgFixture()
    f.p1.nextResolve(complete([]))
    f.p2.nextResolve(complete([providerSvg()]))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['output_rejected', 'succeeded'])
  })

  // `z.any()` would accept an empty list, so only the pipeline's own zero check can reject it.
  it('rejects zero svgs even when the output schema would accept them', async () => {
    const f = fixture({ format: 'svg', output: z.any(), fallback: false })
    f.p1.nextResolve(complete([]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['output_rejected'])
  })

  it('treats absent svgs as zero svgs', async () => {
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve({ kind: 'complete', text: 'no picture', usage: null })
    const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['output_rejected'])
  })

  // The fallback matrix: a provider that answers raster images to an svg request has
  // answered nothing the operation asked for, and the fallback is tried.
  it('ignores images on an svg operation: only images is zero svgs, and falls back', async () => {
    const f = svgFixture()
    f.p1.nextResolve(complete(undefined, { images: [providerImage('image/png')] }))
    f.p2.nextResolve(complete([providerSvg()]))
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['output_rejected', 'succeeded'])
  })

  it('never reads images on an svg operation, even when reading it would throw', async () => {
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(
      withThrowingGetter(
        { kind: 'complete', text: '', usage: null, svgs: [providerSvg()] },
        'images',
      ) as unknown as ProviderResponse,
    )
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as { svgs: unknown[] }).svgs).toHaveLength(1)
  })

  it('hands the quality gate the parsed SvgOutput, after the schema', async () => {
    const seen: unknown[] = []
    const f = fixture({
      format: 'svg',
      fallback: false,
      output: svgOutputSchema.transform((output) => ({ count: output.svgs.length, ...output })),
      quality: ({ data }) => {
        seen.push(data)
        return { ok: true }
      },
    })
    f.p1.nextResolve(complete([providerSvg(), providerSvg()], { text: 't' }))
    await f.ai.run('echo', INPUT)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      count: 2,
      text: 't',
      svgs: [{ type: 'svg' }, { type: 'svg' }],
    })
  })

  it('rejects on a quality verdict of ok false', async () => {
    const f = svgFixture({ quality: () => ({ ok: false, reason: 'too plain' }) })
    f.p1.nextResolve(complete([providerSvg()]))
    f.p2.nextResolve(complete([providerSvg()]))
    await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
  })
})

describe('the hostile svgs matrix classifies malformed_response', () => {
  const valid = providerSvg()
  const cases: { name: string; svgs: unknown; hostile?: string }[] = [
    { name: 'a non-array', svgs: { length: 1 } },
    { name: 'a string', svgs: valid.data },
    { name: 'a null element', svgs: [null] },
    { name: 'a string element', svgs: [valid.data] },
    { name: 'a raster media type', svgs: [{ ...valid, mediaType: 'image/png' }] },
    { name: 'a near-miss media type', svgs: [{ ...valid, mediaType: 'image/svg' }] },
    { name: 'an absent media type', svgs: [{ data: valid.data }] },
    { name: 'a non-string media type', svgs: [{ ...valid, mediaType: 1 }] },
    { name: 'non-string data', svgs: [{ ...valid, data: 1 }] },
    { name: 'empty data', svgs: [{ ...valid, data: '' }] },
    { name: 'data with whitespace', svgs: [{ ...valid, data: `${valid.data}\n` }] },
    {
      name: 'data with a data-URL prefix',
      svgs: [{ ...valid, data: `data:image/svg+xml;base64,${valid.data}` }],
    },
    { name: 'a DOCTYPE', svgs: [providerSvg('<!DOCTYPE svg><svg/>')] },
    { name: 'a document that is not SVG', svgs: [providerSvg('<html/>')] },
    { name: 'a comment hiding the root', svgs: [providerSvg('<!-- <svg/> --><x/>')] },
    {
      name: 'invalid UTF-8',
      svgs: [
        {
          ...valid,
          data: Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0xff]).toString('base64'),
        },
      ],
    },
    {
      name: 'a valid document followed by a malformed one',
      svgs: [valid, { ...valid, mediaType: 'x' }],
    },
    { name: 'a throwing svgs getter', svgs: undefined, hostile: 'svgs' },
    {
      name: 'a throwing element getter',
      svgs: [withThrowingGetter({ mediaType: 'image/svg+xml' }, 'data')],
    },
  ]
  for (const { name, svgs, hostile } of cases) {
    it(`classifies ${name}`, async () => {
      const f = svgFixture({ fallback: false })
      const response =
        hostile === 'svgs'
          ? withThrowingGetter({ kind: 'complete', text: '', usage: null }, 'svgs')
          : complete(svgs)
      f.p1.nextResolve(response as ProviderResponse)
      await expectMalformed(f)
    })
  }

  it('falls back on a malformed document', async () => {
    const f = svgFixture()
    f.p1.nextResolve(complete([providerSvg('<x/>')]))
    f.p2.nextResolve(complete([providerSvg()]))
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['malformed_response', 'succeeded'])
  })

  it('reads by index, so a poisoned iterator on the svgs array changes nothing', async () => {
    const svgs = [providerSvg()] as unknown as Record<symbol, unknown>
    svgs[Symbol.iterator] = () => {
      throw new Error('iterated')
    }
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete(svgs))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as { svgs: unknown[] }).svgs).toHaveLength(1)
  })

  it('keeps the first answer of a getter that changes its mind', async () => {
    let reads = 0
    const svg = Object.defineProperty({ mediaType: 'image/svg+xml' }, 'data', {
      enumerable: true,
      get: () => {
        reads += 1
        if (reads === 1) return valid.data
        throw new Error('second read')
      },
    })
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete([svg]))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as { svgs: { data: string }[] }).svgs[0]?.data).toBe(valid.data)
    expect(reads).toBe(1)
  })
})

describe('the response-side caps (spec §3 point 4c)', () => {
  function copies(count: number): ProviderSvg[] {
    return Array.from({ length: count }, () => providerSvg())
  }

  it('accepts sixteen documents', async () => {
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete(copies(MAX_RESPONSE_SVGS)))
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as z.infer<typeof svgOutputSchema>).svgs).toHaveLength(16)
  })

  it('rejects a seventeenth on the count, without reading element 0', async () => {
    let reads = 0
    const svgs: unknown[] = new Array<unknown>(MAX_RESPONSE_SVGS + 1)
    Object.defineProperty(svgs, 0, {
      enumerable: true,
      get: () => {
        reads += 1
        return providerSvg()
      },
    })
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete(svgs))
    await expectMalformed(f)
    expect(reads).toBe(0)
  })

  it('leaves a document of exactly the per-document cap to the document check', async () => {
    vi.mocked(svgDocumentProblem).mockClear()
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(
      complete([{ mediaType: 'image/svg+xml', data: paddedSvg(MAX_SVG_CHARACTERS) }]),
    )
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as z.infer<typeof svgOutputSchema>).svgs).toHaveLength(1)
    expect(svgDocumentProblem).toHaveBeenCalledTimes(1)
  })

  // Four characters over, so the string is still a valid document: only the cap rejects it.
  it('rejects a document over the per-document cap before any decode', async () => {
    vi.mocked(svgDocumentProblem).mockClear()
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(
      complete([
        providerSvg(),
        { mediaType: 'image/svg+xml', data: paddedSvg(MAX_SVG_CHARACTERS + 4) },
      ]),
    )
    await expectMalformed(f)
    expect(svgDocumentProblem).not.toHaveBeenCalled()
  })

  it('accepts documents totalling exactly the response cap', async () => {
    const data = paddedSvg(MAX_SVG_CHARACTERS)
    const count = MAX_RESPONSE_SVG_CHARACTERS / MAX_SVG_CHARACTERS
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(
      complete(Array.from({ length: count }, () => ({ mediaType: 'image/svg+xml', data }))),
    )
    const result = await f.ai.run('echo', INPUT)
    expect((result.data as z.infer<typeof svgOutputSchema>).svgs).toHaveLength(count)
  })

  it('rejects a response over the total cap before any document is decoded', async () => {
    vi.mocked(svgDocumentProblem).mockClear()
    const data = paddedSvg(MAX_SVG_CHARACTERS)
    const svgs: ProviderSvg[] = Array.from(
      { length: MAX_RESPONSE_SVG_CHARACTERS / MAX_SVG_CHARACTERS },
      () => ({ mediaType: 'image/svg+xml', data }),
    )
    svgs.push(providerSvg())
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete(svgs))
    await expectMalformed(f)
    expect(svgDocumentProblem).not.toHaveBeenCalled()
  })

  it('checks the media type of every element before decoding any', async () => {
    vi.mocked(svgDocumentProblem).mockClear()
    const f = svgFixture({ fallback: false })
    f.p1.nextResolve(complete([providerSvg(), { ...providerSvg(), mediaType: 'image/png' }]))
    await expectMalformed(f)
    expect(svgDocumentProblem).not.toHaveBeenCalled()
  })
})

describe('svgs outside svg format', () => {
  it('is never read on a json operation, even when reading it would throw', async () => {
    const f = fixture()
    f.p1.nextResolve(
      withThrowingGetter(
        { kind: 'complete', text: '{"answer":"ok"}', usage: null },
        'svgs',
      ) as unknown as ProviderResponse,
    )
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toEqual({ answer: 'ok' })
  })

  it('is never read on a text operation', async () => {
    const f = fixture({ format: 'text', output: z.string() })
    f.p1.nextResolve({ kind: 'complete', text: 'plain', usage: null, svgs: 'garbage' } as never)
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toBe('plain')
  })

  // The fallback matrix's other direction: an image request answered only with svgs is zero
  // images, and the svgs are never looked at.
  it('is never read on an image operation, so svgs alone are zero images', async () => {
    const f = fixture({ format: 'image', output: imageOutputSchema, fallback: false })
    f.p1.nextResolve(
      withThrowingGetter({ kind: 'complete', text: '', usage: null }, 'svgs') as never,
    )
    const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['output_rejected'])
  })
})

describe('the svg pricing rule (spec §7)', () => {
  const PRICING = {
    pricing: { p1: { m1: { inputPerM: 1000, outputPerM: 2000, imageOutputPerM: 40_000 } } },
  }

  it('prices null without a reported cost or a split, whatever outputTokens says', async () => {
    for (const usage of [
      { inputTokens: 10, outputTokens: 0 },
      { inputTokens: 10, outputTokens: 5 },
    ]) {
      const f = svgFixture({ config: PRICING, fallback: false })
      f.p1.nextResolve(complete([providerSvg()], { usage }))
      const result = await f.ai.run('echo', INPUT)
      expect(result.attempts[0]?.costUsd).toBeNull()
      expect(result.cost).toBeNull()
    }
  })

  it('applies the image rate to an explicit split', async () => {
    const f = svgFixture({ config: PRICING, fallback: false })
    f.p1.nextResolve(
      complete([providerSvg()], {
        usage: { inputTokens: 10, outputTokens: 7, imageOutputTokens: 5 },
      }),
    )
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts[0]?.costUsd).toBeCloseTo(
      (10 * 1000) / 1e6 + (2 * 2000) / 1e6 + (5 * 40_000) / 1e6,
      12,
    )
  })

  it('takes a reported cost over the table', async () => {
    const f = svgFixture({ config: PRICING, fallback: false })
    f.p1.nextResolve(complete([providerSvg()], { costUsd: 0.08 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts[0]?.costUsd).toBe(0.08)
    expect(result.cost).toBe(0.08)
  })

  it('prices a rejected svg attempt by the same rule', async () => {
    const f = svgFixture({ config: PRICING, fallback: false })
    f.p1.nextResolve(complete([]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
    expect(error.attempts?.[0]?.costUsd).toBeNull()
  })
})

describe('svgOutputSchema', () => {
  const svg = { type: 'svg', mediaType: 'image/svg+xml', data: 'AAAA' }

  it('accepts a list of documents with text and rejects an empty one', () => {
    expect(svgOutputSchema.safeParse({ svgs: [svg], text: '' }).success).toBe(true)
    expect(svgOutputSchema.safeParse({ svgs: [], text: '' }).success).toBe(false)
    expect(svgOutputSchema.safeParse({ svgs: [svg] }).success).toBe(false)
  })

  it('checks shape only: the type, the media type and non-empty data', () => {
    expect(
      svgOutputSchema.safeParse({ svgs: [{ ...svg, type: 'file' }], text: '' }).success,
    ).toBe(false)
    expect(
      svgOutputSchema.safeParse({ svgs: [{ ...svg, mediaType: 'image/png' }], text: '' })
        .success,
    ).toBe(false)
    expect(svgOutputSchema.safeParse({ svgs: [{ ...svg, data: '' }], text: '' }).success).toBe(
      false,
    )
    // Not a document check: base64 of something that is not SVG still has the right shape.
    expect(
      svgOutputSchema.safeParse({ svgs: [{ ...svg, data: b64('<html/>') }], text: '' }).success,
    ).toBe(true)
  })

  it('does not accept image output, nor the other way round', () => {
    const image = { type: 'file', mediaType: 'image/png', data: 'AAAA', width: 1, height: 1 }
    expect(svgOutputSchema.safeParse({ svgs: [image], text: '' }).success).toBe(false)
    expect(imageOutputSchema.safeParse({ images: [svg], text: '' }).success).toBe(false)
  })
})
