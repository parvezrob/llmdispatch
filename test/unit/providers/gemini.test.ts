import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { gemini } from '../../../src/providers/gemini'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  SENTINEL,
  withPrepared,
} from './helpers'

const KEY = () => 'goog-key-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function complete() {
  return withPrepared(gemini({ apiKey: KEY }))
}

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
}

describe('request shape', () => {
  it('builds the URL from HOST, path and the encoded model', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ model: 'gemini-x' }))
    expect(requests[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent',
    )
  })

  // A model containing URL-meaningful characters proves encodeURIComponent runs, not a bare
  // string interpolation — an unencoded value would change the request path (D11).
  it.each([
    ['slash', 'org/model', 'org%2Fmodel'],
    ['question mark', 'model?x', 'model%3Fx'],
    ['hash', 'model#tag', 'model%23tag'],
  ])('encodes a model containing a %s', async (_label, model, encoded) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ model }))
    expect(requests[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${encoded}:generateContent`,
    )
  })

  it('sends x-goog-api-key, not Authorization', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.headers['x-goog-api-key']).toBe('goog-key-test')
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  it('sends the prompt as contents[0].parts[0].text', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ prompt: 'say hi' }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'say hi' }] }])
  })

  it('omits generationConfig entirely when no optional field applies', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect('generationConfig' in (requests[0]!.body as Record<string, unknown>)).toBe(false)
  })

  it('sends maxOutputTokens and temperature inside generationConfig when set', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ maxOutputTokens: 256, temperature: 0.5 }))
    const config = (requests[0]!.body as Record<string, unknown>).generationConfig as Record<
      string,
      unknown
    >
    expect(config.maxOutputTokens).toBe(256)
    expect(config.temperature).toBe(0.5)
    expect('responseMimeType' in config).toBe(false)
  })

  it('sets responseMimeType only for json-object format, not json-any or text', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ responseFormat: { type: 'json', topLevel: 'object' } }))
    const config = (requests[0]!.body as Record<string, unknown>).generationConfig as Record<
      string,
      unknown
    >
    expect(config.responseMimeType).toBe('application/json')
  })

  it.each([
    ['json-any', { type: 'json', topLevel: 'any' } as const],
    ['text', { type: 'text' } as const],
  ])('omits responseMimeType and generationConfig for %s', async (_label, responseFormat) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ responseFormat }))
    expect('generationConfig' in (requests[0]!.body as Record<string, unknown>)).toBe(false)
  })

  it("always fetches with redirect: 'error'", async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.redirect).toBe('error')
  })

  it('passes the exact request signal through to fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    const req = baseRequest()
    await run(req)
    expect(requests[0]!.signal).toBe(req.signal)
  })
})

describe('termination mapping', () => {
  it('maps promptFeedback.blockReason to refused before the no-candidates check', async () => {
    installFetch(() => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }))
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
    expect(response.text).toBe('')
  })

  it('throws malformed_response for no candidates without block metadata', async () => {
    installFetch(() => jsonResponse(200, { candidates: [] }))
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it("maps finishReason 'MAX_TOKENS' to truncated", async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'truncated', text: 'partial', usage: null })
  })

  it.each([
    'SAFETY',
    'RECITATION',
    'PROHIBITED_CONTENT',
    'BLOCKLIST',
    'SPII',
    'ESCALATION',
    'LANGUAGE',
  ])("maps finishReason '%s' to refused", async (finishReason) => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
  })

  it("maps finishReason 'STOP' to complete", async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'complete', text: 'done', usage: null })
  })

  it('throws malformed_response for an unrecognized finishReason', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'OTHER' }],
      }),
    )
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it('concatenates multiple text parts', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [
          { content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'STOP' },
        ],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.text).toBe('ab')
  })
})

describe('error classification', () => {
  it.each([
    ['401 -> auth', 401, {}, 'auth'],
    ['403 -> auth', 403, {}, 'auth'],
    ['404 -> model_not_found', 404, {}, 'model_not_found'],
    ['429 -> rate_limit', 429, {}, 'rate_limit'],
    [
      'RESOURCE_EXHAUSTED status string -> rate_limit',
      400,
      { error: { status: 'RESOURCE_EXHAUSTED' } },
      'rate_limit',
    ],
    ['500 -> transient', 500, {}, 'transient'],
    ['503 -> transient', 503, {}, 'transient'],
    ['400 -> invalid_request', 400, {}, 'invalid_request'],
    [
      'INVALID_ARGUMENT status string -> invalid_request',
      418,
      { error: { status: 'INVALID_ARGUMENT' } },
      'invalid_request',
    ],
    ['498 family default -> invalid_request', 498, {}, 'invalid_request'],
  ])('%s', async (_label, status, body, expectedKind) => {
    installFetch(() => jsonResponse(status, body))
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === expectedKind,
    )
  })

  it('classifies an abort-triggered fetch rejection as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    installFetch(() => {
      throw new Error('fetch aborted')
    })
    const run = await complete()
    await expect(run(baseRequest({ signal: controller.signal }))).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'aborted',
    )
  })

  it('classifies a plain network failure (no abort) as transient', async () => {
    installFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )
  })

  it('never embeds the fixture body sentinel in a thrown message', async () => {
    installFetch(() => jsonResponse(400, { error: { message: `bad: ${SENTINEL}` } }))
    const run = await complete()
    try {
      await run(baseRequest({ prompt: SENTINEL }))
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL)
    }
  })
})

describe('usage normalization', () => {
  it('requires promptTokenCount and candidatesTokenCount; missing -> null', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it.each([
    ['non-number promptTokenCount', { promptTokenCount: '10', candidatesTokenCount: 5 }],
    ['negative candidatesTokenCount', { promptTokenCount: 10, candidatesTokenCount: -5 }],
    ['fractional promptTokenCount', { promptTokenCount: 10.5, candidatesTokenCount: 5 }],
  ])('is null when %s', async (_label, usageMetadata) => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata,
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it('adds thoughtsTokenCount into outputTokens, default 0 when absent', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 8 })
  })

  it('is null when thoughtsTokenCount is present but invalid, never coerced to 0', async () => {
    installFetch(() =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: -1,
        },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })
})
