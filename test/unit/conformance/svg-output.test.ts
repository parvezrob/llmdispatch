/**
 * The `svg_output` conformance scenario (spec §6b, §8): guarded on the request's
 * `responseFormat`, asserting a complete response with one to 16 well-formed `ProviderSvg`s
 * within the core's three caps, skipped like any other optional scenario when not supplied,
 * and its copies of those caps held to the originals. The document check is core behaviour and is not run here.
 */

import { describe, expect, it } from 'vitest'

import { runProviderConformance } from '../../../src/conformance'
import {
  MAX_CONFORMANT_SVG_CHARACTERS,
  MAX_CONFORMANT_SVG_RESPONSE_CHARACTERS,
  MAX_CONFORMANT_SVGS,
} from '../../../src/conformance/provider'
import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
} from '../../../src/core/svg-document'
import { ProviderError } from '../../../src/errors'
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/types'
import { baseRequest } from '../providers/helpers'

const SVG = { mediaType: 'image/svg+xml', data: 'PHN2Zy8+' } as const

function providerAnswering(response: unknown): Provider {
  return {
    complete: (req) => {
      if (req.signal.aborted) return Promise.reject(new ProviderError('aborted'))
      return Promise.resolve(response as ProviderResponse)
    },
  }
}

function svgRequest(): ProviderRequest {
  return baseRequest({ responseFormat: { type: 'svg' } })
}

async function run(response: unknown, request: () => ProviderRequest = svgRequest) {
  return runProviderConformance({
    provider: providerAnswering(response),
    requestFactory: () => baseRequest(),
    scenarios: { success: () => Promise.resolve(), svg_output: () => Promise.resolve() },
    requests: { svg_output: request },
  })
}

function complete(svgs: unknown, usage: unknown = null): unknown {
  return { kind: 'complete', text: '', usage, svgs }
}

describe('the copies of the core caps', () => {
  it('cap a response at the same count, per-document length and total as the core', () => {
    expect(MAX_CONFORMANT_SVGS).toBe(MAX_RESPONSE_SVGS)
    expect(MAX_CONFORMANT_SVG_CHARACTERS).toBe(MAX_SVG_CHARACTERS)
    expect(MAX_CONFORMANT_SVG_RESPONSE_CHARACTERS).toBe(MAX_RESPONSE_SVG_CHARACTERS)
  })
})

describe('svg_output', () => {
  it('passes on a complete response with well-formed documents', async () => {
    const result = await run(
      complete([SVG, { ...SVG, data: 'PHN2Zz4=' }], { inputTokens: 1, outputTokens: 0 }),
    )
    expect(result).toEqual({ passed: true, failures: [], skipped: expect.any(Array) as never })
    expect(result.skipped).not.toContain('svg_output')
  })

  it('passes at the count cap and at the per-document length cap', async () => {
    const atCount = await run(complete(Array.from({ length: MAX_CONFORMANT_SVGS }, () => SVG)))
    expect(atCount.passed).toBe(true)
    const atLength = await run(
      complete([{ ...SVG, data: 'A'.repeat(MAX_CONFORMANT_SVG_CHARACTERS) }]),
    )
    expect(atLength.passed).toBe(true)
  })

  it('passes at the response cap and fails one past it, before any grammar scan', async () => {
    const data = 'A'.repeat(MAX_CONFORMANT_SVG_CHARACTERS)
    const count = MAX_CONFORMANT_SVG_RESPONSE_CHARACTERS / MAX_CONFORMANT_SVG_CHARACTERS
    const atTotal = await run(complete(Array.from({ length: count }, () => ({ ...SVG, data }))))
    expect(atTotal.passed).toBe(true)
    // The fifth document is not even valid base64: the total cap is what reports it.
    const over = await run(
      complete([
        ...Array.from({ length: count }, () => ({ ...SVG, data })),
        { ...SVG, data: `${data.slice(0, -1)}*` },
      ]),
    )
    expect(over.failures).toEqual([
      'svg_output: expected at most 40000000 base64 characters across svgs',
    ])
  })

  it('does not run the document check: the core does that', async () => {
    // Base64 of `<html/>`, which the core would classify malformed_response.
    const result = await run(complete([{ ...SVG, data: 'PGh0bWwvPg==' }]))
    expect(result.passed).toBe(true)
  })

  it('is skipped when the scenario or its request is absent, last in the order', async () => {
    const provider = providerAnswering({ kind: 'complete', text: '', usage: null })
    const withoutRequest = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: () => Promise.resolve(), svg_output: () => Promise.resolve() },
    })
    expect(withoutRequest.skipped).toContain('svg_output')
    const withoutScenario = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: () => Promise.resolve() },
      requests: { svg_output: svgRequest },
    })
    expect(withoutScenario.skipped.at(-1)).toBe('svg_output')
  })

  it('fails a request that does not ask for svg, before dispatching', async () => {
    for (const responseFormat of [{ type: 'image' }, { type: 'text' }] as const) {
      const result = await run(complete([SVG]), () => baseRequest({ responseFormat }))
      expect(result.failures).toEqual([
        "svg_output: expected a request carrying responseFormat.type 'svg' but it carried none",
      ])
    }
  })

  const failing: [string, unknown, string][] = [
    [
      'a non-complete kind',
      { kind: 'truncated', text: '', usage: null },
      "expected kind 'complete'",
    ],
    ['no svgs', { kind: 'complete', text: '', usage: null }, 'non-empty array'],
    ['an empty svgs array', complete([]), 'non-empty array'],
    ['svgs that is not an array', complete({ length: 1 }), 'non-empty array'],
    [
      'only raster images',
      {
        kind: 'complete',
        text: '',
        usage: null,
        images: [{ mediaType: 'image/png', data: 'AAAA' }],
      },
      'non-empty array',
    ],
    [
      'more documents than the count cap',
      complete(Array.from({ length: MAX_CONFORMANT_SVGS + 1 }, () => SVG)),
      'expected at most 16 svgs but got 17',
    ],
    ['a non-object document', complete(['x']), 'svgs[0] must be an object'],
    ['a sparse svgs array', complete(new Array(1)), 'svgs[0] must be an object'],
    [
      'a raster media type',
      complete([{ ...SVG, mediaType: 'image/png' }]),
      'svgs[0] mediaType',
    ],
    ['an absent media type', complete([{ data: SVG.data }]), 'svgs[0] mediaType'],
    ['non-string data', complete([{ ...SVG, data: 1 }]), 'svgs[0] data must be a string'],
    ['empty data', complete([{ ...SVG, data: '' }]), 'svgs[0] data must be non-empty'],
    [
      'data outside the base64 grammar',
      complete([{ ...SVG, data: 'AAA' }]),
      'svgs[0] data must be non-empty',
    ],
    [
      'data over the per-document cap',
      complete([{ ...SVG, data: 'A'.repeat(MAX_CONFORMANT_SVG_CHARACTERS + 4) }]),
      'svgs[0] data must be at most 10000000 characters',
    ],
    [
      'a second malformed document after a good one',
      complete([SVG, { ...SVG, data: 'data:x' }]),
      'svgs[1] data',
    ],
    [
      'a split larger than outputTokens',
      complete([SVG], { inputTokens: 1, outputTokens: 2, imageOutputTokens: 3 }),
      'usage must be',
    ],
  ]
  for (const [name, response, fragment] of failing) {
    it(`fails on ${name}`, async () => {
      const result = await run(response)
      expect(result.passed).toBe(false)
      expect(
        result.failures.some((f) => f.startsWith('svg_output') && f.includes(fragment)),
      ).toBe(true)
    })
  }
})
