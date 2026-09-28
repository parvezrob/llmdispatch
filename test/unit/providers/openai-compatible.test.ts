import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import {
  baseRequest,
  captureRequests,
  inheritedValue,
  installFetch,
  jsonResponse,
  SENTINEL,
  textParts,
  throwingGetter,
  withInherited,
  withPrepared,
} from './helpers'
import {
  AUTH_WORDS,
  ERROR_TYPE_LOCATIONS,
  MODERATION_METADATA_BODY,
  MODERATION_WORDS,
  RATE_LIMIT_WORDS,
  typedErrorBody,
} from './openrouter-fixtures'

const KEY = () => 'sk-test'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function complete(opts: Parameters<typeof openaiCompatible>[0]) {
  return withPrepared(openaiCompatible(opts))
}

const OK_BODY = {
  choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}

describe('request shape', () => {
  // A wrong baseUrl join or a missing trailing-slash strip sends every request to a 404.
  it.each([
    ['default baseUrl', undefined, 'https://api.openai.com/v1/chat/completions'],
    [
      'custom baseUrl, no trailing slash',
      'https://example.com/v1',
      'https://example.com/v1/chat/completions',
    ],
    [
      'custom baseUrl, trailing slash',
      'https://example.com/v1/',
      'https://example.com/v1/chat/completions',
    ],
  ])('%s', async (_label, baseUrl, expectedUrl) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY, ...(baseUrl === undefined ? {} : { baseUrl }) })
    await run(baseRequest())
    expect(requests[0]!.url).toBe(expectedUrl)
  })

  it('sends a Bearer authorization header built from the resolved key', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY })
    await run(baseRequest())
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-test')
  })

  it('sends model and messages always, and omits maxOutputTokens/temperature when unset', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY })
    await run(baseRequest({ model: 'gpt-x', parts: textParts('say hi') }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.model).toBe('gpt-x')
    expect(body.messages).toEqual([{ role: 'user', content: 'say hi' }])
    expect('max_completion_tokens' in body).toBe(false)
    expect('max_tokens' in body).toBe(false)
    expect('temperature' in body).toBe(false)
  })

  it('sends maxOutputTokens and temperature when the route sets them', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY, baseUrl: 'https://openrouter.ai/api/v1' })
    await run(baseRequest({ maxOutputTokens: 256, temperature: 0.4 }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body.max_tokens).toBe(256)
    expect(body.temperature).toBe(0.4)
  })

  // The host-specific token parameter, not a hardcoded name: kills a fixed 'max_tokens'.
  it.each([
    [
      'api.openai.com default -> max_completion_tokens',
      undefined,
      undefined,
      'max_completion_tokens',
    ],
    [
      'other host default -> max_tokens',
      'https://openrouter.ai/api/v1',
      undefined,
      'max_tokens',
    ],
    ['override on api.openai.com', undefined, 'max_tokens', 'max_tokens'],
    [
      'override on other host',
      'https://openrouter.ai/api/v1',
      'max_completion_tokens',
      'max_completion_tokens',
    ],
  ])('%s', async (_label, baseUrl, tokenParam, expectedKey) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({
      apiKey: KEY,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(tokenParam === undefined
        ? {}
        : { tokenParam: tokenParam as 'max_tokens' | 'max_completion_tokens' }),
    })
    await run(baseRequest({ maxOutputTokens: 100 }))
    const body = requests[0]!.body as Record<string, unknown>
    expect(body[expectedKey]).toBe(100)
    const other = expectedKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    expect(other in body).toBe(false)
  })

  // The capability table (native/gateway/unknown) x both override knobs: kills a rule that
  // always sends response_format, or never does.
  const TEXT = { type: 'text' } as const
  const JSON_OBJECT = { type: 'json', topLevel: 'object' } as const
  const JSON_ANY = { type: 'json', topLevel: 'any' } as const
  it.each([
    ['native host, json object -> sent', undefined, undefined, JSON_OBJECT, true],
    ['native host, json any -> omitted', undefined, undefined, JSON_ANY, false],
    [
      'gateway host, json object, default prompt-only -> omitted',
      'https://openrouter.ai/api/v1',
      undefined,
      JSON_OBJECT,
      false,
    ],
    [
      'unknown host, json object, default prompt-only -> omitted',
      'https://example.com/v1',
      undefined,
      JSON_OBJECT,
      false,
    ],
    [
      'gateway host, jsonMode native override -> sent',
      'https://openrouter.ai/api/v1',
      'native',
      JSON_OBJECT,
      true,
    ],
    [
      'native host, jsonMode prompt-only override -> omitted',
      undefined,
      'prompt-only',
      JSON_OBJECT,
      false,
    ],
    ['native host, text format -> omitted', undefined, undefined, TEXT, false],
  ] as const)('%s', async (_label, baseUrl, jsonMode, responseFormat, expectSent) => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({
      apiKey: KEY,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(jsonMode === undefined ? {} : { jsonMode }),
    })
    await run(baseRequest({ responseFormat }))
    const body = requests[0]!.body as Record<string, unknown>
    expect('response_format' in body).toBe(expectSent)
    if (expectSent) expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it("always fetches with redirect: 'error'", async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY })
    await run(baseRequest())
    expect(requests[0]!.redirect).toBe('error')
  })

  it('passes the exact request signal through to fetch', async () => {
    const { requests } = captureRequests(() => jsonResponse(200, OK_BODY))
    const run = await complete({ apiKey: KEY })
    const req = baseRequest()
    await run(req)
    expect(requests[0]!.signal).toBe(req.signal)
  })
})

describe('termination mapping', () => {
  it("maps a non-empty message.refusal to 'refused' even when finish_reason is stop", async () => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: '', refusal: 'no' }, finish_reason: 'stop' }],
      }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
  })

  it("maps finish_reason 'length' to 'truncated'", async () => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
      }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'truncated', text: 'partial', usage: null })
  })

  it("maps finish_reason 'content_filter' to 'refused'", async () => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
  })

  it("maps finish_reason 'stop' to 'complete'", async () => {
    installFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response).toEqual({ kind: 'complete', text: 'done', usage: null })
  })

  it('throws malformed_response for a missing or unrecognized finish_reason', async () => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }],
      }),
    )
    const run = await complete({ apiKey: KEY })
    await expect(run(baseRequest())).rejects.toMatchObject({
      kind: 'malformed_response',
    })
  })

  it('throws malformed_response when the body has no choices array', async () => {
    installFetch(() => jsonResponse(200, { choices: [] }))
    const run = await complete({ apiKey: KEY })
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'malformed_response',
    )
  })
})

describe('error classification', () => {
  it.each([
    ['401 -> auth', 401, {}, 'auth'],
    ['403 without moderation -> auth', 403, {}, 'auth'],
    ['404 -> model_not_found', 404, {}, 'model_not_found'],
    ['429 -> rate_limit', 429, {}, 'rate_limit'],
    ['402 -> rate_limit', 402, {}, 'rate_limit'],
    ['408 -> transient', 408, {}, 'transient'],
    ['500 -> transient', 500, {}, 'transient'],
    ['498 -> transient (openaiCompatible-only row)', 498, {}, 'transient'],
    ['400 -> invalid_request', 400, {}, 'invalid_request'],
    ['413 -> invalid_request', 413, {}, 'invalid_request'],
    ['422 -> invalid_request', 422, {}, 'invalid_request'],
    ['418 unmapped -> invalid_request (family)', 418, {}, 'invalid_request'],
    [
      '400 with model_not_found code -> model_not_found',
      400,
      { error: { code: 'model_not_found' } },
      'model_not_found',
    ],
    [
      '400 with model_not_found type -> model_not_found',
      400,
      { error: { type: 'model_not_found' } },
      'model_not_found',
    ],
    [
      '400 whose message mentions model not found without a code -> invalid_request',
      400,
      { error: { message: 'model not found' } },
      'invalid_request',
    ],
    [
      '429 whose message mentions model not found -> rate_limit',
      429,
      { error: { message: 'model not found; retry' } },
      'rate_limit',
    ],
    [
      '500 whose message mentions model not found -> transient',
      500,
      { error: { message: 'upstream unavailable: model not found' } },
      'transient',
    ],
  ])('%s', async (_label, status, body, expectedKind) => {
    installFetch(() => jsonResponse(status, body))
    const run = await complete({ apiKey: KEY })
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === expectedKind,
    )
  })

  it('classifies a 403 with OpenRouter moderation metadata as invalid_request', async () => {
    installFetch(() => jsonResponse(403, { error: { type: 'moderation' } }))
    const run = await complete({ apiKey: KEY, baseUrl: 'https://openrouter.ai/api/v1' })
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'invalid_request',
    )
  })

  it('classifies an abort-triggered fetch rejection as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    installFetch(() => {
      throw new Error('fetch aborted')
    })
    const run = await complete({ apiKey: KEY })
    await expect(run(baseRequest({ signal: controller.signal }))).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'aborted',
    )
  })

  it('classifies a plain network failure (no abort) as transient', async () => {
    installFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const run = await complete({ apiKey: KEY })
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )
  })

  it.each([
    ['auth metadata -> auth', { error: { type: 'authentication' } }, 'auth'],
    ['credit metadata -> rate_limit', { error: { type: 'credit' } }, 'rate_limit'],
    ['unrecognized metadata -> transient', { error: { type: 'server_error' } }, 'transient'],
    [
      'choice-level finish_reason error, no envelope -> transient',
      { choices: [{ finish_reason: 'error', message: { content: '' } }] },
      'transient',
    ],
  ])('embedded HTTP-200 OpenRouter envelope: %s', async (_label, body, expectedKind) => {
    installFetch(() => jsonResponse(200, body))
    const run = await complete({ apiKey: KEY, baseUrl: 'https://openrouter.ai/api/v1' })
    await expect(run(baseRequest())).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === expectedKind,
    )
  })

  it('embedded HTTP-200 OpenRouter moderation returns refused', async () => {
    installFetch(() => jsonResponse(200, { error: { type: 'moderation' } }))
    const run = await complete({ apiKey: KEY, baseUrl: 'https://openrouter.ai/api/v1' })
    const response = await run(baseRequest())
    expect(response.kind).toBe('refused')
  })

  it('never embeds the fixture body sentinel in a thrown message', async () => {
    installFetch(() => jsonResponse(400, { error: { message: `bad request: ${SENTINEL}` } }))
    const run = await complete({ apiKey: KEY })
    try {
      await run(baseRequest({ parts: textParts(SENTINEL) }))
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL)
    }
  })
})

describe('usage normalization', () => {
  it('is null when the usage envelope is absent', async () => {
    installFetch(() =>
      jsonResponse(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it.each([
    ['non-number prompt_tokens', { prompt_tokens: '10', completion_tokens: 5 }],
    ['negative completion_tokens', { prompt_tokens: 10, completion_tokens: -5 }],
    ['fractional prompt_tokens', { prompt_tokens: 10.5, completion_tokens: 5 }],
    [
      'unsafe prompt_tokens',
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 10, completion_tokens: 5 },
    ],
  ])('is null when %s', async (_label, usage) => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage,
      }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response.usage).toBeNull()
  })

  it('carries the exact counters when both are valid, never zero-defaulted', async () => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    )
    const run = await complete({ apiKey: KEY })
    const response = await run(baseRequest())
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })
})

describe("OpenRouter's documented error vocabulary, on an OpenRouter host", () => {
  const OPENROUTER = 'https://openrouter.ai/api/v1'

  async function answer(status: number, body: unknown, baseUrl = OPENROUTER) {
    installFetch(() => jsonResponse(status, body))
    const run = await complete({ apiKey: KEY, baseUrl })
    return run(baseRequest())
  }

  async function failureKind(status: number, body: unknown, baseUrl = OPENROUTER) {
    const error: unknown = await answer(status, body, baseUrl).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(ProviderError.is(error)).toBe(true)
    expect((error as ProviderError).status).toBe(status)
    return (error as ProviderError).kind
  }

  function everyLocation(words: readonly string[]) {
    return words.flatMap((word) =>
      ERROR_TYPE_LOCATIONS.map((location) => [word, location] as const),
    )
  }

  it('classifies a 403 carrying moderation metadata, and no type, as invalid_request', async () => {
    expect(await failureKind(403, MODERATION_METADATA_BODY)).toBe('invalid_request')
  })

  it.each(everyLocation(MODERATION_WORDS))(
    'classifies a 403 naming %s by %s as invalid_request',
    async (word, location) => {
      expect(await failureKind(403, typedErrorBody(location, word, 403))).toBe(
        'invalid_request',
      )
    },
  )

  it.each(ERROR_TYPE_LOCATIONS)(
    'classifies a 403 naming permission_denied by %s as auth',
    async (location) => {
      expect(await failureKind(403, typedErrorBody(location, 'permission_denied', 403))).toBe(
        'auth',
      )
    },
  )

  it('returns refused for the moderation metadata embedded in a 200', async () => {
    const response = await answer(200, {
      choices: [{ finish_reason: 'error', error: MODERATION_METADATA_BODY.error }],
      usage: { prompt_tokens: 7, completion_tokens: 0 },
    })
    expect(response).toEqual({
      kind: 'refused',
      text: '',
      usage: { inputTokens: 7, outputTokens: 0 },
    })
  })

  it.each(everyLocation(MODERATION_WORDS))(
    'returns refused for an embedded %s named by %s',
    async (word, location) => {
      expect((await answer(200, typedErrorBody(location, word))).kind).toBe('refused')
    },
  )

  it.each(everyLocation(RATE_LIMIT_WORDS))(
    'classifies an embedded %s named by %s as rate_limit',
    async (word, location) => {
      expect(await failureKind(200, typedErrorBody(location, word))).toBe('rate_limit')
    },
  )

  it.each(everyLocation(AUTH_WORDS))(
    'classifies an embedded %s named by %s as auth',
    async (word, location) => {
      expect(await failureKind(200, typedErrorBody(location, word))).toBe('auth')
    },
  )

  it('reads the error_type of a choice-level error in a 200', async () => {
    const body = {
      choices: [
        {
          finish_reason: 'error',
          error: {
            code: 429,
            message: 'slow down',
            metadata: { error_type: 'rate_limit_exceeded' },
          },
        },
      ],
    }
    expect(await failureKind(200, body)).toBe('rate_limit')
  })

  describe('a host that is not OpenRouter ignores all of it', () => {
    const OTHER = 'https://api.openai.com/v1'

    it.each([
      ['moderation metadata', MODERATION_METADATA_BODY],
      [
        'content_policy_violation',
        typedErrorBody('metadata.error_type', 'content_policy_violation', 403),
      ],
      ['refusal', typedErrorBody('error.error_type', 'refusal', 403)],
    ])('classifies a 403 with %s as auth', async (_label, body) => {
      expect(await failureKind(403, body, OTHER)).toBe('auth')
    })

    it.each([
      ['moderation metadata', MODERATION_METADATA_BODY],
      [
        'content_policy_violation',
        typedErrorBody('metadata.error_type', 'content_policy_violation'),
      ],
      ['rate_limit_exceeded', typedErrorBody('top-level error_type', 'rate_limit_exceeded')],
      ['permission_denied', typedErrorBody('error.error_type', 'permission_denied')],
    ])(
      'reads a 200 carrying %s beside a completion as the completion',
      async (_label, error) => {
        const response = await answer(200, { ...error, ...OK_BODY }, OTHER)
        expect(response).toEqual({
          kind: 'complete',
          text: 'hi',
          usage: { inputTokens: 10, outputTokens: 5 },
        })
      },
    )
  })
})

describe('an inherited envelope field, on an OpenRouter host', () => {
  // Only the fields a body carries classify it: a polluted Object.prototype neither names an
  // error nor runs a getter. The answer is prepared before the pollution and read after it.
  async function outcomeUnder(
    fields: Record<string, PropertyDescriptor>,
    status: number,
    body: unknown,
  ) {
    const response = jsonResponse(status, body)
    installFetch(() => response)
    const run = await complete({ apiKey: KEY, baseUrl: 'https://openrouter.ai/api/v1' })
    return withInherited(Object.prototype, fields, () =>
      run(baseRequest()).then(
        () => null,
        (thrown: unknown) => thrown,
      ),
    )
  }

  it('keeps an embedded credit error rate_limit when Object.prototype names moderation', async () => {
    const error = await outcomeUnder({ error_type: inheritedValue('moderation') }, 200, {
      error: { type: 'credit' },
    })
    expect(ProviderError.is(error) && error.kind === 'rate_limit').toBe(true)
  })

  it('keeps a 403 without moderation auth when Object.prototype carries moderation', async () => {
    const error = await outcomeUnder(
      {
        error_type: inheritedValue('moderation'),
        metadata: inheritedValue({ reasons: ['violence'] }),
      },
      403,
      { error: { code: 403, message: 'forbidden' } },
    )
    expect(ProviderError.is(error) && error.kind === 'auth').toBe(true)
  })

  it.each(['error_type', 'metadata', 'reasons', 'flagged_input', 'code', 'type'])(
    'never runs an inherited %s getter: the embedded error stays a ProviderError',
    async (name) => {
      const error = await outcomeUnder({ [name]: throwingGetter() }, 200, {
        error: { type: 'credit' },
      })
      expect(ProviderError.is(error) && error.kind === 'rate_limit').toBe(true)
    },
  )
})
