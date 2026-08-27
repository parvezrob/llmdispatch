import { afterEach, describe, expect, it, vi } from 'vitest'

import { runProviderConformance } from '../../../src/conformance'
import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { gemini } from '../../../src/providers/gemini'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import type {
  Provider,
  ProviderErrorKind,
  ProviderRequest,
  ProviderResponse,
} from '../../../src/types'
import { baseRequest, installFetch, jsonResponse } from '../providers/helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every optional scenario, in the order the runner always drives them. */
const OPTIONAL_ORDER = [
  'auth',
  'rate_limit',
  'model_not_found',
  'invalid_request',
  'transient',
  'malformed_response',
  'truncated',
  'refused',
  'document',
  'image',
]

/** Base64 short enough to read; no adapter here decodes it. */
const FILE_DATA = 'AAAA'

type Handler = (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>

/** A scenario setup as the runner's opts want it: synchronous work, `Promise<void>` shape. */
function step(action: () => void): () => Promise<void> {
  return () => {
    action()
    return Promise.resolve()
  }
}

function okResponse(): ProviderResponse {
  return { kind: 'complete', text: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } }
}

/**
 * A `Provider` whose one behaviour is swapped out per scenario, like `okResponse` above.
 *
 * Honors an already-aborted signal on its own, the way a conforming adapter must, so every
 * test here exercises exactly the dimension it names, not the mandatory signal-honour check
 * too. `nonAbortingProvider` below is the one deliberate exception.
 */
function scriptedProvider(): { provider: Provider; set: (handler: Handler) => void } {
  let handler: Handler = () => okResponse()
  return {
    provider: {
      complete: (req) => {
        if (req.signal.aborted) return Promise.reject(new ProviderError('aborted'))
        return Promise.resolve().then(() => handler(req))
      },
    },
    set: (next) => {
      handler = next
    },
  }
}

/** A nonconforming `Provider` that never checks its signal at all. */
function nonAbortingProvider(): Provider {
  return { complete: () => Promise.resolve(okResponse()) }
}

function throwing(kind: ProviderErrorKind): Handler {
  return () => {
    throw new ProviderError(kind)
  }
}

describe('runner behavior', () => {
  it('passes with only the mandatory success scenario supplied', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
    })
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('reports each absent optional scenario in skipped, in the documented order', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
    })
    expect(result.skipped).toEqual(['responseFormat', ...OPTIONAL_ORDER])
  })

  it('lands a failing scenario in failures, named by the scenario', async () => {
    const { provider, set } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        rate_limit: step(() => {
          set(throwing('auth'))
        }),
      },
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((failure) => failure.startsWith('rate_limit:'))).toBe(true)
  })

  it('reports a scenario setup that throws, named by the scenario, and keeps running', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        auth: () => Promise.reject(new Error('setup exploded')),
      },
    })
    expect(result.failures).toContain('auth: Error: setup exploded')
    expect(result.skipped).toContain('rate_limit') // the run did not stop after the failure
  })

  it('is passed exactly when failures is empty, regardless of what is skipped', async () => {
    const { provider, set } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        auth: step(() => {
          set(throwing('auth'))
        }),
      },
    })
    expect(result.skipped.length).toBeGreaterThan(0)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('invokes observeRequest with each dispatched ProviderRequest, not a wire body', async () => {
    const { provider } = scriptedProvider()
    const seen: ProviderRequest[] = []
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest({ model: 'observed' }),
      scenarios: { success: step(() => undefined) },
      controls: { observeRequest: (req) => seen.push(req) },
    })
    expect(result.passed).toBe(true)
    // Mandatory success plus the already-aborted signal check, both go through dispatch.
    expect(seen.length).toBe(2)
    expect(seen.every((req) => req.model === 'observed')).toBe(true)
    expect(seen[1]!.signal.aborted).toBe(true)
  })
})

describe('media scenarios', () => {
  const pdfRequest = () =>
    baseRequest({
      parts: [
        { type: 'text', text: 'read it' },
        { type: 'file', mediaType: 'application/pdf', data: FILE_DATA },
      ],
    })
  const imageRequest = () =>
    baseRequest({
      parts: [
        { type: 'text', text: 'look at it' },
        { type: 'file', mediaType: 'image/png', data: FILE_DATA },
      ],
    })

  it('passes both when each has a scenario and a request carrying its media class', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        document: step(() => undefined),
        image: step(() => undefined),
      },
      requests: { document: pdfRequest, image: imageRequest },
    })
    expect(result.failures).toEqual([])
    expect(result.skipped).not.toContain('document')
    expect(result.skipped).not.toContain('image')
  })

  it('dispatches each media scenario its own request, not the shared requestFactory', async () => {
    const { provider } = scriptedProvider()
    const seen: ProviderRequest[] = []
    await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined), image: step(() => undefined) },
      requests: { image: imageRequest },
      controls: { observeRequest: (req) => seen.push(req) },
    })
    expect(seen.at(-1)!.parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      data: FILE_DATA,
    })
  })

  it('skips a media scenario whose request is missing, and the other way round', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined), document: step(() => undefined) },
      requests: { image: imageRequest },
    })
    expect(result.skipped).toContain('document')
    expect(result.skipped).toContain('image')
    expect(result.failures).toEqual([])
  })

  it('fails a media scenario whose request carries no file part at all', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined), document: step(() => undefined) },
      requests: { document: () => baseRequest() },
    })
    expect(result.failures).toContainEqual(
      expect.stringContaining("document: expected a request carrying an 'application/pdf'"),
    )
  })

  it('fails the document scenario whose file part is an image instead', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined), document: step(() => undefined) },
      requests: { document: imageRequest },
    })
    expect(result.failures).toContainEqual(
      expect.stringContaining("document: expected a request carrying an 'application/pdf'"),
    )
  })

  it('fails the image scenario whose file part is a document instead', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined), image: step(() => undefined) },
      requests: { image: pdfRequest },
    })
    expect(result.failures).toContainEqual(
      expect.stringContaining('image: expected a request carrying an image file part'),
    )
  })

  it('fails a media scenario answered with a response that is not complete', async () => {
    const { provider, set } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        // Set inside the scenario, so only the media dispatch answers this way.
        document: step(() => {
          set(() => ({
            kind: 'truncated',
            text: 'partial',
            usage: { inputTokens: 1, outputTokens: 1 },
          }))
        }),
      },
      requests: { document: pdfRequest },
    })
    expect(result.failures).toContainEqual(
      "document: expected kind 'complete' but was 'truncated'",
    )
  })

  it('fails a media scenario the provider rejects with a ProviderError', async () => {
    const { provider, set } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        image: step(() => {
          set(throwing('invalid_request'))
        }),
      },
      requests: { image: imageRequest },
    })
    expect(result.failures).toContainEqual(
      expect.stringContaining('image: ProviderError(invalid_request)'),
    )
  })
})

describe('nonconforming fakes', () => {
  it('fails when the success scenario answers with the wrong ProviderResponse shape', async () => {
    const { provider, set } = scriptedProvider()
    // Every dispatch resolves 'truncated', never the 'complete' the success case requires.
    set(() => ({ kind: 'truncated', text: 'partial', usage: null }))
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
    })
    expect(result.failures.some((failure) => failure.startsWith('success:'))).toBe(true)
  })

  it('fails when a successful response carries invalid usage instead of null', async () => {
    const { provider, set } = scriptedProvider()
    set(() => ({
      kind: 'complete',
      text: '{"ok":true}',
      usage: { inputTokens: -1, outputTokens: 2 },
    }))
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
    })
    expect(
      result.failures.some((failure) => failure.includes('usage must be TokenUsage or null')),
    ).toBe(true)
  })

  it('fails the signal check when the provider ignores an already-aborted signal', async () => {
    const result = await runProviderConformance({
      provider: nonAbortingProvider(),
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
    })
    expect(result.failures.some((failure) => failure.startsWith('signal:'))).toBe(true)
  })

  it('fails a scenario that resolves the wrong ProviderError kind', async () => {
    const { provider, set } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: {
        success: step(() => undefined),
        rate_limit: step(() => {
          set(throwing('auth'))
        }),
      },
    })
    expect(result.failures).toContainEqual(
      expect.stringContaining("rate_limit: expected ProviderError('rate_limit')"),
    )
  })
})

describe('responseFormat duty', () => {
  it('fails when a native-capable provider answers json mode with unparseable text', async () => {
    const { provider, set } = scriptedProvider()
    set(() => ({ kind: 'complete', text: 'not json', usage: null }))
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
      controls: { jsonCapability: 'native' },
    })
    expect(
      result.failures.some((failure) =>
        failure.includes('native capability returned complete text that is not JSON'),
      ),
    ).toBe(true)
  })

  it('passes the duty when a native-capable provider answers json mode with parseable text', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
      controls: { jsonCapability: 'native' },
    })
    expect(result.failures.some((failure) => failure.startsWith('responseFormat'))).toBe(false)
    expect(result.skipped).not.toContain('responseFormat')
  })

  it('reports prompt-only as an unverified skip, not a failure', async () => {
    const { provider } = scriptedProvider()
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest(),
      scenarios: { success: step(() => undefined) },
      controls: { jsonCapability: 'prompt-only' },
    })
    expect(result.skipped).toContain('responseFormat:native')
    expect(result.failures).toEqual([])
  })
})

describe('the built-in adapters, driven end to end through the runner', () => {
  const KEY = () => 'sk-test'

  /** The media requests for one adapter's model, each carrying the part its scenario checks. */
  const mediaRequests = (model: string) => ({
    document: () =>
      baseRequest({
        model,
        parts: [
          { type: 'text', text: 'read it' },
          { type: 'file', mediaType: 'application/pdf', data: FILE_DATA },
        ],
      }),
    image: () =>
      baseRequest({
        model,
        parts: [
          { type: 'text', text: 'look at it' },
          { type: 'file', mediaType: 'image/png', data: FILE_DATA },
        ],
      }),
  })

  it('passes openaiCompatible over scripted fetch, native json capability', async () => {
    const provider = openaiCompatible({ apiKey: KEY })
    const chatBody = (finishReason: string, content: string, refusal?: string) => ({
      choices: [
        {
          message: { content, ...(refusal === undefined ? {} : { refusal }) },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest({ model: 'gpt-x' }),
      scenarios: {
        success: step(() =>
          installFetch(() => jsonResponse(200, chatBody('stop', '{"ok":true}'))),
        ),
        auth: step(() => installFetch(() => jsonResponse(401, {}))),
        rate_limit: step(() => installFetch(() => jsonResponse(429, {}))),
        model_not_found: step(() => installFetch(() => jsonResponse(404, {}))),
        invalid_request: step(() => installFetch(() => jsonResponse(400, {}))),
        transient: step(() => installFetch(() => jsonResponse(500, {}))),
        malformed_response: step(() =>
          installFetch(() => jsonResponse(200, chatBody('tool_calls', 'x'))),
        ),
        truncated: step(() =>
          installFetch(() => jsonResponse(200, chatBody('length', 'partial'))),
        ),
        refused: step(() => installFetch(() => jsonResponse(200, chatBody('stop', '', 'no')))),
        document: step(() =>
          installFetch(() => jsonResponse(200, chatBody('stop', '{"ok":true}'))),
        ),
        image: step(() =>
          installFetch(() => jsonResponse(200, chatBody('stop', '{"ok":true}'))),
        ),
      },
      requests: mediaRequests('gpt-x'),
      controls: { jsonCapability: 'native' },
    })
    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('passes anthropic over scripted fetch, prompt-only json capability', async () => {
    const provider = anthropic({ apiKey: KEY })
    const messageBody = (stopReason: string, text: string) => ({
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest({ model: 'claude-x' }),
      scenarios: {
        success: step(() =>
          installFetch(() => jsonResponse(200, messageBody('end_turn', '{"ok":true}'))),
        ),
        auth: step(() => installFetch(() => jsonResponse(401, {}))),
        rate_limit: step(() => installFetch(() => jsonResponse(429, {}))),
        model_not_found: step(() => installFetch(() => jsonResponse(404, {}))),
        invalid_request: step(() => installFetch(() => jsonResponse(400, {}))),
        transient: step(() => installFetch(() => jsonResponse(500, {}))),
        malformed_response: step(() =>
          installFetch(() => jsonResponse(200, messageBody('tool_use', 'x'))),
        ),
        truncated: step(() =>
          installFetch(() => jsonResponse(200, messageBody('max_tokens', 'partial'))),
        ),
        refused: step(() => installFetch(() => jsonResponse(200, messageBody('refusal', '')))),
        document: step(() =>
          installFetch(() => jsonResponse(200, messageBody('end_turn', '{"ok":true}'))),
        ),
        image: step(() =>
          installFetch(() => jsonResponse(200, messageBody('end_turn', '{"ok":true}'))),
        ),
      },
      requests: mediaRequests('claude-x'),
      controls: { jsonCapability: 'prompt-only' },
    })
    expect(result).toEqual({ passed: true, failures: [], skipped: ['responseFormat:native'] })
  })

  it('passes gemini over scripted fetch, prompt-only json capability', async () => {
    const provider = gemini({ apiKey: KEY })
    const generateBody = (finishReason: string, text: string) => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    })
    const result = await runProviderConformance({
      provider,
      requestFactory: () => baseRequest({ model: 'gemini-x' }),
      scenarios: {
        success: step(() =>
          installFetch(() => jsonResponse(200, generateBody('STOP', '{"ok":true}'))),
        ),
        auth: step(() => installFetch(() => jsonResponse(401, {}))),
        rate_limit: step(() => installFetch(() => jsonResponse(429, {}))),
        model_not_found: step(() => installFetch(() => jsonResponse(404, {}))),
        invalid_request: step(() => installFetch(() => jsonResponse(400, {}))),
        transient: step(() => installFetch(() => jsonResponse(500, {}))),
        malformed_response: step(() =>
          installFetch(() => jsonResponse(200, generateBody('OTHER', 'x'))),
        ),
        truncated: step(() =>
          installFetch(() => jsonResponse(200, generateBody('MAX_TOKENS', 'partial'))),
        ),
        refused: step(() => installFetch(() => jsonResponse(200, generateBody('SAFETY', '')))),
        document: step(() =>
          installFetch(() => jsonResponse(200, generateBody('STOP', '{"ok":true}'))),
        ),
        image: step(() =>
          installFetch(() => jsonResponse(200, generateBody('STOP', '{"ok":true}'))),
        ),
      },
      requests: mediaRequests('gemini-x'),
      controls: { jsonCapability: 'prompt-only' },
    })
    expect(result).toEqual({ passed: true, failures: [], skipped: ['responseFormat:native'] })
  })
})
