/**
 * Shared instruments for the provider adapter tests: a scripted global `fetch`, request
 * capture, a sentinel for body-leak assertions, and a default `ProviderRequest`.
 */

import { vi } from 'vitest'

import type { PreparedProvider, Provider, ProviderRequest } from '../../../src/types'

/** Present in prompts and never allowed to reach a thrown `ProviderError` message. */
export const SENTINEL = 'PROMPT_SENTINEL_BODY_XYZ'

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  redirect: RequestInit['redirect']
  signal: AbortSignal | undefined
}

function toHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

function parseBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') return init.body
  try {
    return JSON.parse(init.body) as unknown
  } catch {
    return init.body
  }
}

/** Builds a `Response` whose body is JSON, or `null` for an empty body. */
export function jsonResponse(status: number, body: unknown): Response {
  const text = body === null ? '' : JSON.stringify(body)
  return new Response(text, { status, headers: { 'content-type': 'application/json' } })
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

/** Real fetch rejects instantly on an already-aborted signal, never reaching the network. */
function abortRejection(): Promise<never> {
  return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
}

/** Stubs global `fetch` with one handler for every call. Returns the restore function. */
export function installFetch(handler: FetchHandler): () => void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (init.signal?.aborted === true) return abortRejection()
      return Promise.resolve(handler(url, init))
    }),
  )
  return () => vi.unstubAllGlobals()
}

export interface Captured {
  requests: CapturedRequest[]
  fetch: ReturnType<typeof vi.fn>
}

/**
 * Stubs global `fetch`, logging every call's method/url/headers/parsed body.
 *
 * `handler` decides the response; defaults to one empty 200. Restore with
 * `vi.unstubAllGlobals()` in `afterEach`.
 */
export function captureRequests(handler: FetchHandler = () => jsonResponse(200, {})): Captured {
  const requests: CapturedRequest[] = []
  const fetch = vi.fn((url: string, init: RequestInit) => {
    if (init.signal?.aborted === true) return abortRejection()
    requests.push({
      url,
      method: init.method ?? 'GET',
      headers: toHeaders(init),
      body: parseBody(init),
      redirect: init.redirect,
      signal: init.signal ?? undefined,
    })
    return Promise.resolve(handler(url, init))
  })
  vi.stubGlobal('fetch', fetch)
  return { requests, fetch }
}

/** One `ProviderRequest`, with a fresh signal, overridable field by field. */
export function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    prompt: 'hello',
    model: 'test-model',
    responseFormat: { type: 'text' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Runs `provider.prepare()` (when present) and returns the dispatcher's `complete`. */
export async function withPrepared(provider: Provider): Promise<PreparedProvider['complete']> {
  if (provider.prepare === undefined) return provider.complete.bind(provider)
  const prepared = await provider.prepare()
  return prepared.complete.bind(prepared)
}
