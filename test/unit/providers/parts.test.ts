/**
 * What every built-in adapter does with `ProviderRequest.parts`: the single text part is
 * serialized the plain way each adapter's own suite asserts, and anything else is refused
 * as `invalid_request` before a request is made, carrying no part data or filename.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { gemini } from '../../../src/providers/gemini'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import type { ContentPart, PreparedProvider } from '../../../src/types'
import { baseRequest, captureRequests, textParts, withPrepared } from './helpers'

const DATA_SENTINEL = 'U0VOVElORUxfREFUQV84YjJm'
const FILENAME_SENTINEL = 'SENTINEL_FILENAME_4d7e.pdf'

const PDF: ContentPart = {
  type: 'file',
  mediaType: 'application/pdf',
  data: DATA_SENTINEL,
  filename: FILENAME_SENTINEL,
}

const ADAPTERS: { name: string; build: () => Promise<PreparedProvider['complete']> }[] = [
  { name: 'anthropic', build: () => withPrepared(anthropic({ apiKey: () => 'k' })) },
  { name: 'gemini', build: () => withPrepared(gemini({ apiKey: () => 'k' })) },
  {
    name: 'openai-compatible',
    build: () => withPrepared(openaiCompatible({ apiKey: () => 'k' })),
  },
]

const UNSUPPORTED: { name: string; parts: readonly ContentPart[] }[] = [
  { name: 'a file part', parts: [PDF] },
  { name: 'a text part beside a file part', parts: [{ type: 'text', text: 'read this' }, PDF] },
  {
    name: 'two text parts',
    parts: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

for (const { name, build } of ADAPTERS) {
  describe(`${name} on parts it cannot map yet`, () => {
    for (const unsupported of UNSUPPORTED) {
      it(`refuses ${unsupported.name} as invalid_request without dispatching`, async () => {
        const { requests } = captureRequests()
        const complete = await build()
        await expect(complete(baseRequest({ parts: unsupported.parts }))).rejects.toSatisfy(
          (error: unknown) => ProviderError.is(error) && error.kind === 'invalid_request',
        )
        expect(requests).toHaveLength(0)
      })
    }

    it('keeps the file data and filename out of the refusal message', async () => {
      captureRequests()
      const complete = await build()
      try {
        await complete(baseRequest({ parts: [PDF] }))
        expect.unreachable('expected a rejection')
      } catch (error) {
        const { message } = error as Error
        expect(message).not.toContain(DATA_SENTINEL)
        expect(message).not.toContain(FILENAME_SENTINEL)
      }
    })

    it('carries nothing beyond the fixed message and the classification', async () => {
      captureRequests()
      const complete = await build()
      try {
        await complete(baseRequest({ parts: [PDF] }))
        expect.unreachable('expected a rejection')
      } catch (error) {
        const thrown = error as ProviderError
        expect(thrown.message).toBe('only a single text part is supported')
        expect(thrown.kind).toBe('invalid_request')
        expect(thrown.status).toBeUndefined()
        expect('cause' in thrown).toBe(false)
        // Its own fields are exactly the class's fixed pair: none was added for a part to
        // travel in, and neither holds anything the caller supplied.
        expect(Object.keys(thrown).sort()).toEqual(['kind', 'name'])
        expect(JSON.stringify(Object.values(thrown))).not.toContain(DATA_SENTINEL)
        expect(JSON.stringify(Object.values(thrown))).not.toContain(FILENAME_SENTINEL)
      }
    })

    it('still serializes an empty text part, which is a legal prompt', async () => {
      const { requests } = captureRequests()
      const complete = await build()
      await complete(baseRequest({ parts: textParts('') })).catch(() => undefined)
      expect(requests).toHaveLength(1)
    })
  })
}
