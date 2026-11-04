/**
 * The svg gate (spec §5c): `openrouterImages` is the one built-in adapter with a vector
 * output wire. Each of the other four rejects an svg request as `invalid_request` before
 * any fetch, whatever its knobs. For `gemini` this is what keeps an svg request out of text
 * mode; for `openaiImages` it is its existing format gate, pinned here for the new member.
 * The positive case below only shows `openrouterImages` reaching the wire;
 * `openrouter-images-svg.test.ts` pins its body and its reading of the answer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { gemini } from '../../../src/providers/gemini'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { openaiImages } from '../../../src/providers/openai-images'
import { openrouterImages } from '../../../src/providers/openrouter-images'
import type { ProviderRequest } from '../../../src/types'
import { baseRequest, captureRequests, jsonResponse, withPrepared } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const KEY = () => 'key-test'

const adapters = [
  ['anthropic', () => anthropic({ apiKey: KEY }), 'svg output is not supported'],
  ['openaiCompatible', () => openaiCompatible({ apiKey: KEY }), 'svg output is not supported'],
  ['gemini', () => gemini({ apiKey: KEY }), 'svg output is not supported'],
  ['openaiImages', () => openaiImages({ apiKey: KEY }), 'only image output is supported'],
] as const

const requests: [string, ProviderRequest['responseFormat']][] = [
  ['a bare svg request', { type: 'svg' }],
  ['an svg request with both knobs', { type: 'svg', count: 2, aspectRatio: '1:1' }],
]

describe.each(adapters)('%s', (_name, make, message) => {
  it.each(requests)(
    'throws invalid_request on %s without touching fetch',
    async (_label, responseFormat) => {
      const { requests: sent } = captureRequests()
      const run = await withPrepared(make())
      let caught: unknown
      try {
        await run(baseRequest({ responseFormat }))
      } catch (error) {
        caught = error
      }
      expect(ProviderError.is(caught)).toBe(true)
      expect((caught as ProviderError).kind).toBe('invalid_request')
      expect((caught as ProviderError).message).toBe(message)
      expect(sent).toHaveLength(0)
    },
  )
})

describe('openrouterImages', () => {
  it.each(requests)('dispatches %s, once', async (_label, responseFormat) => {
    const answer = { data: [{ b64_json: 'PHN2Zy8+', media_type: 'image/svg+xml' }] }
    const { requests: sent } = captureRequests(() => jsonResponse(200, answer))
    const run = await withPrepared(openrouterImages({ apiKey: KEY }))
    const response = await run(baseRequest({ responseFormat }))
    expect(response).toEqual({
      kind: 'complete',
      text: '',
      svgs: [{ mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }],
      usage: null,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ output_format: 'svg' })
  })
})
