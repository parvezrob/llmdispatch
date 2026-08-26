/**
 * Body settlement is still network I/O (spec §5c): a reset or abort during `response.text()`
 * must classify as `transient` / `aborted`, never leak a raw fetch error that the core would
 * treat as `provider_unclassified`. Unparseable JSON stays a null body, not a network error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { fetchJson } from '../../../src/providers/transport'

afterEach(() => {
  vi.unstubAllGlobals()
})

const init = {
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: new AbortController().signal,
}

function stubFetch(response: { status: number; text: () => Promise<string> }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response as unknown as Response)),
  )
}

describe('fetchJson body settlement', () => {
  it('classifies a connection reset during body read as transient, never a raw TypeError', async () => {
    stubFetch({
      status: 200,
      text: () => Promise.reject(new TypeError('terminated')),
    })
    await expect(fetchJson('https://example.com/v1', init)).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )
  })

  it('classifies an abort that wins during body read as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort()
        return Promise.resolve({
          status: 200,
          text: () =>
            Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
        } as unknown as Response)
      }),
    )
    await expect(
      fetchJson('https://example.com/v1', { ...init, signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => ProviderError.is(error) && error.kind === 'aborted')
  })

  it('returns a 200 with unparseable JSON as a null body, not a network failure', async () => {
    stubFetch({
      status: 200,
      text: () => Promise.resolve('not-json{'),
    })
    await expect(fetchJson('https://example.com/v1', init)).resolves.toEqual({
      status: 200,
      body: null,
    })
  })
})
