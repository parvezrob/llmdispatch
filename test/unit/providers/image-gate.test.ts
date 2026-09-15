/**
 * The transitional image gate (spec §5c): every built-in adapter that maps no image wire
 * rejects an image request as `invalid_request` before any fetch. The gemini adapter maps
 * the wire, so its own gate (transparent background) lives in `gemini.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { baseRequest, captureRequests, withPrepared } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const KEY = () => 'key-test'

const adapters = [
  ['anthropic', () => anthropic({ apiKey: KEY })],
  ['openaiCompatible', () => openaiCompatible({ apiKey: KEY })],
] as const

describe.each(adapters)('%s', (_name, make) => {
  it('throws invalid_request on an image request without touching fetch', async () => {
    const { requests } = captureRequests()
    const run = await withPrepared(make())
    let caught: unknown
    try {
      await run(baseRequest({ responseFormat: { type: 'image', count: 2 } }))
    } catch (error) {
      caught = error
    }
    expect(ProviderError.is(caught)).toBe(true)
    expect((caught as ProviderError).kind).toBe('invalid_request')
    expect(requests).toHaveLength(0)
  })
})
