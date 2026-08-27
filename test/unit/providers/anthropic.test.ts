import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  SENTINEL,
  textParts,
  withPrepared,
} from './helpers'

const KEY = () => 'sk-ant-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function complete() {
  return withPrepared(anthropic({ apiKey: KEY }))
}

const OK_BODY = {
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
}

describe('request shape', () => {
  it('posts to the fixed Messages endpoint', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]!.method).toBe('POST')
  })

  it('sends x-api-key and the pinned anthropic-version, not Authorization', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect(requests[0]!.headers['x-api-key']).toBe('sk-ant-test')
    expect(requests[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  it('sends model and the user message', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ model: 'claude-x', parts: textParts('say hi') }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.model).toBe('claude-x')
    expect(body.messages).toEqual([{ role: 'user', content: 'say hi' }])
  })

  it('always sends max_tokens, defaulting to 4096 when the route sets none', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect((requests[0]!.body as Record<string, unknown>).max_tokens).toBe(4096)
  })

  it('sends the exact max_tokens the route configured', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ maxOutputTokens: 512 }))
    expect((requests[0]!.body as Record<string, unknown>).max_tokens).toBe(512)
  })

  it('omits temperature entirely when unset', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest())
    expect('temperature' in (requests[0]!.body as Record<string, unknown>)).toBe(false)
  })

  it.each([
    ['within range passes through', 0.6, 0.6],
    ['above range clamps to 1', 1.7, 1],
    ['below range clamps to 0', -0.3, 0],
    ['exactly 0 stays 0, not omitted', 0, 0],
    ['exactly 1 stays 1', 1, 1],
  ])('temperature clamp: %s', async (_label, temperature, expected) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete()
    await run(baseRequest({ temperature }))
    expect((requests[0]!.body as Record<string, unknown>).temperature).toBe(expected)
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
  it.each([
    ['max_tokens -> truncated', 'max_tokens', 'truncated'],
    [
      'model_context_window_exceeded -> truncated',
      'model_context_window_exceeded',
      'truncated',
    ],
    ['refusal -> refused', 'refusal', 'refused'],
    ['end_turn -> complete', 'end_turn', 'complete'],
    ['stop_sequence -> complete', 'stop_sequence', 'complete'],
  ])('%s', async (_label, stopReason, expectedKind) => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'body' }],
        stop_reason: stopReason,
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.kind).toBe(expectedKind)
  })

  it('throws malformed_response for an unrecognized stop_reason', async () => {
    installFetch(() =>
      jsonResponse(200, { content: [{ type: 'text', text: 'x' }], stop_reason: 'tool_use' }),
    )
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it('extracts the first text block, ignoring non-text blocks before and after', async () => {
    installFetch(() =>
      jsonResponse(200, {
        content: [
          { type: 'tool_use', id: 't1' },
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        stop_reason: 'end_turn',
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.text).toBe('first')
  })
})

describe('error classification', () => {
  it.each([
    [
      'authentication_error type -> auth',
      { error: { type: 'authentication_error' } },
      undefined,
      'auth',
    ],
    ['401 without envelope -> auth', {}, 401, 'auth'],
    ['403 without envelope -> auth', {}, 403, 'auth'],
    [
      'not_found_error type -> model_not_found',
      { error: { type: 'not_found_error' } },
      undefined,
      'model_not_found',
    ],
    ['404 without envelope -> model_not_found', {}, 404, 'model_not_found'],
    [
      'rate_limit_error type -> rate_limit',
      { error: { type: 'rate_limit_error' } },
      undefined,
      'rate_limit',
    ],
    ['429 without envelope -> rate_limit', {}, 429, 'rate_limit'],
    [
      'overloaded_error type -> transient',
      { error: { type: 'overloaded_error' } },
      undefined,
      'transient',
    ],
    ['529 without envelope -> transient', {}, 529, 'transient'],
    ['500 without envelope -> transient', {}, 500, 'transient'],
    [
      'invalid_request_error type -> invalid_request',
      { error: { type: 'invalid_request_error' } },
      undefined,
      'invalid_request',
    ],
    ['400 without envelope -> invalid_request', {}, 400, 'invalid_request'],
    ['498 family default -> invalid_request', {}, 498, 'invalid_request'],
  ])('%s', async (_label, body, status, expectedKind) => {
    installFetch(() => jsonResponse(status ?? 400, body))
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

  it('throws malformed_response when the body is not a JSON object', async () => {
    installFetch(() => new Response('not json', { status: 200 }))
    const run = await complete()
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })

  it('never embeds the fixture body sentinel in a thrown message', async () => {
    installFetch(() => jsonResponse(400, { error: { message: `bad: ${SENTINEL}` } }))
    const run = await complete()
    try {
      await run(baseRequest({ parts: textParts(SENTINEL) }))
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL)
    }
  })
})

describe('usage normalization', () => {
  it('requires both input_tokens and output_tokens; missing -> null', async () => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it.each([
    ['non-number input_tokens', { input_tokens: '5', output_tokens: 5 }],
    ['negative output_tokens', { input_tokens: 5, output_tokens: -1 }],
    ['fractional input_tokens', { input_tokens: 5.5, output_tokens: 5 }],
  ])('is null when %s', async (_label, usage) => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage,
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it('sums the cache categories additively into inputTokens, default 0 when absent', async () => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('adds cache_creation_input_tokens and cache_read_input_tokens into inputTokens', async () => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
        },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 15, outputTokens: 5 })
  })

  it('is null when a present cache category is invalid, never coerced to 0', async () => {
    installFetch(() =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: -1 },
      }),
    )
    const run = await complete()
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })
})
