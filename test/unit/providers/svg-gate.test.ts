/**
 * The svg gate (spec §5c): no built-in adapter has a vector output wire yet, so each one
 * rejects an svg request as `invalid_request` before any fetch, whatever its knobs. For
 * `gemini` this is what keeps an svg request out of text mode; for the two image-only
 * adapters it is their existing format gate, pinned here for the new member.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { gemini } from '../../../src/providers/gemini'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { openaiImages } from '../../../src/providers/openai-images'
import { openrouterImages } from '../../../src/providers/openrouter-images'
import type { ProviderRequest } from '../../../src/types'
import { baseRequest, captureRequests, withPrepared } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const KEY = () => 'key-test'

const adapters = [
  ['anthropic', () => anthropic({ apiKey: KEY }), 'svg output is not supported'],
  ['openaiCompatible', () => openaiCompatible({ apiKey: KEY }), 'svg output is not supported'],
  ['gemini', () => gemini({ apiKey: KEY }), 'svg output is not supported'],
  ['openaiImages', () => openaiImages({ apiKey: KEY }), 'only image output is supported'],
  [
    'openrouterImages',
    () => openrouterImages({ apiKey: KEY }),
    'only image output is supported',
  ],
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
