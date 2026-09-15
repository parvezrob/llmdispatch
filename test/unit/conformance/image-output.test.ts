/**
 * The `image_output` conformance scenario (spec §6b, §8): guarded on the request's
 * `responseFormat`, asserting a complete response with at least one well-formed
 * `ProviderImage`, and skipped like any other optional scenario when not supplied.
 */

import { describe, expect, it } from 'vitest'

import { runProviderConformance } from '../../../src/conformance'
import { ProviderError } from '../../../src/errors'
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/types'
import { baseRequest } from '../providers/helpers'

const IMAGE = { mediaType: 'image/png', data: 'AAAA' } as const

function providerAnswering(response: unknown): Provider {
  return {
    complete: (req) => {
      if (req.signal.aborted) return Promise.reject(new ProviderError('aborted'))
      return Promise.resolve(response as ProviderResponse)
    },
  }
}

function imageRequest(): ProviderRequest {
  return baseRequest({ responseFormat: { type: 'image' } })
}

async function run(response: unknown, request: () => ProviderRequest = imageRequest) {
  return runProviderConformance({
    provider: providerAnswering(response),
    requestFactory: () => baseRequest(),
    scenarios: { success: () => Promise.resolve(), image_output: () => Promise.resolve() },
    requests: { image_output: request },
  })
}

describe('image_output', () => {
  it('passes on a complete response with well-formed images, dimensioned or not', async () => {
    const result = await run({
      kind: 'complete',
      text: '',
      usage: { inputTokens: 1, outputTokens: 4, imageOutputTokens: 4 },
      images: [IMAGE, { ...IMAGE, mediaType: 'image/jpeg', width: 2, height: 3 }],
    })
    expect(result).toEqual({ passed: true, failures: [], skipped: expect.any(Array) as never })
    expect(result.skipped).not.toContain('image_output')
  })

  it('is skipped when the scenario or its request is absent', async () => {
    const provider = providerAnswering({ kind: 'complete', text: '', usage: null })
    const withoutRequest = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: () => Promise.resolve(), image_output: () => Promise.resolve() },
    })
    expect(withoutRequest.skipped).toContain('image_output')
    const withoutScenario = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: () => Promise.resolve() },
      requests: { image_output: imageRequest },
    })
    expect(withoutScenario.skipped).toContain('image_output')
    expect(withoutScenario.skipped.at(-1)).toBe('image_output')
  })

  it('fails a request that does not ask for images, before dispatching', async () => {
    const result = await run({ kind: 'complete', text: '', usage: null, images: [IMAGE] }, () =>
      baseRequest(),
    )
    expect(result.passed).toBe(false)
    expect(result.failures).toEqual([
      "image_output: expected a request carrying responseFormat.type 'image' but it carried none",
    ])
  })

  const failing: [string, unknown, string][] = [
    [
      'a non-complete kind',
      { kind: 'refused', text: '', usage: null },
      "expected kind 'complete'",
    ],
    ['no images', { kind: 'complete', text: '', usage: null }, 'non-empty array'],
    [
      'an empty images array',
      { kind: 'complete', text: '', usage: null, images: [] },
      'non-empty array',
    ],
    [
      'a non-object image',
      { kind: 'complete', text: '', usage: null, images: ['x'] },
      'images[0] must be an object',
    ],
    [
      'a mime outside the three',
      {
        kind: 'complete',
        text: '',
        usage: null,
        images: [{ ...IMAGE, mediaType: 'image/gif' }],
      },
      'images[0] mediaType',
    ],
    [
      'data outside the base64 grammar',
      { kind: 'complete', text: '', usage: null, images: [{ ...IMAGE, data: 'AAA' }] },
      'images[0] data',
    ],
    [
      'one dimension without the other',
      { kind: 'complete', text: '', usage: null, images: [{ ...IMAGE, width: 2 }] },
      'images[0] width and height',
    ],
    [
      'a non-positive dimension',
      { kind: 'complete', text: '', usage: null, images: [{ ...IMAGE, width: 0, height: 2 }] },
      'images[0] width and height',
    ],
    [
      'a split larger than outputTokens',
      {
        kind: 'complete',
        text: '',
        usage: { inputTokens: 1, outputTokens: 2, imageOutputTokens: 3 },
        images: [IMAGE],
      },
      'usage must be',
    ],
    [
      'a sparse images array',
      { kind: 'complete', text: '', usage: null, images: new Array(1) },
      'images[0] must be an object',
    ],
    [
      'a second malformed image after a good one',
      { kind: 'complete', text: '', usage: null, images: [IMAGE, { ...IMAGE, data: '' }] },
      'images[1] data',
    ],
  ]
  for (const [name, response, fragment] of failing) {
    it(`fails on ${name}`, async () => {
      const result = await run(response)
      expect(result.passed).toBe(false)
      expect(
        result.failures.some((f) => f.startsWith('image_output') && f.includes(fragment)),
      ).toBe(true)
    })
  }
})
