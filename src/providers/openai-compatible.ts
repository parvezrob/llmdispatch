/**
 * OpenAI-compatible chat.completions adapter (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ApiKeyResolver,
  PreparedProvider,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../types'
import {
  buildUsage,
  classifyByStatusFamily,
  fetchJson,
  isRecord,
  throwForStatus,
} from './transport'

const DEFAULT_BASE = 'https://api.openai.com/v1'

const NATIVE_JSON_HOSTS = new Set([
  'api.openai.com',
  'api.deepseek.com',
  'api.groq.com',
  'api.mistral.ai',
])

const GATEWAY_HOSTS = new Set(['openrouter.ai', 'api.together.xyz', 'api.fireworks.ai'])

/** Builds an OpenAI-compatible chat provider. Keys resolve in `prepare()`. */
export function openaiCompatible(opts: {
  apiKey: ApiKeyResolver
  baseUrl?: string
  jsonMode?: 'native' | 'prompt-only'
  tokenParam?: 'max_tokens' | 'max_completion_tokens'
}): Provider {
  const baseUrl = normalizeBase(opts.baseUrl ?? DEFAULT_BASE)
  return {
    async prepare(): Promise<PreparedProvider> {
      const key = await opts.apiKey()
      if (key === undefined || key === '') {
        throw new Error('missing api key')
      }
      const apiKey = key
      return {
        complete(req: ProviderRequest): Promise<ProviderResponse> {
          return completeOpenAI(apiKey, baseUrl, opts.jsonMode, opts.tokenParam, req)
        },
      }
    },
    complete(): Promise<ProviderResponse> {
      throw new ProviderError('auth', { message: 'prepare required' })
    },
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

function jsonCapability(
  host: string,
  override: 'native' | 'prompt-only' | undefined,
): 'native' | 'prompt-only' {
  if (override !== undefined) return override
  if (NATIVE_JSON_HOSTS.has(host)) return 'native'
  if (GATEWAY_HOSTS.has(host)) return 'prompt-only'
  return 'prompt-only'
}

function tokenParamFor(
  host: string,
  override: 'max_tokens' | 'max_completion_tokens' | undefined,
): 'max_tokens' | 'max_completion_tokens' {
  if (override !== undefined) return override
  return host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'
}

async function completeOpenAI(
  apiKey: string,
  baseUrl: string,
  jsonMode: 'native' | 'prompt-only' | undefined,
  tokenParam: 'max_tokens' | 'max_completion_tokens' | undefined,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  const host = hostOf(baseUrl)
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [{ role: 'user', content: req.prompt }],
  }

  if (req.maxOutputTokens !== undefined) {
    body[tokenParamFor(host, tokenParam)] = req.maxOutputTokens
  }
  if (req.temperature !== undefined) {
    body.temperature = req.temperature
  }
  if (
    req.responseFormat.type === 'json' &&
    req.responseFormat.topLevel === 'object' &&
    jsonCapability(host, jsonMode) === 'native'
  ) {
    body.response_format = { type: 'json_object' }
  }

  const http = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  if (http.status < 200 || http.status >= 300) {
    throwOpenAIError(http.status, http.body, host)
  }

  if (!isRecord(http.body)) {
    throw new ProviderError('malformed_response', { status: http.status })
  }

  const usage = readOpenAIUsage(http.body.usage)

  const embedded = classifyEmbeddedError(http.body, host)
  if (embedded !== null) {
    if (embedded.kind === 'refused') {
      return { kind: 'refused', text: '', usage }
    }
    throw new ProviderError(embedded.kind, {
      status: embedded.status ?? http.status,
    })
  }

  const choices = http.body.choices
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new ProviderError('malformed_response', { status: http.status })
  }
  const choice = choices[0]
  const message = isRecord(choice.message) ? choice.message : null
  const text = message !== null && typeof message.content === 'string' ? message.content : ''

  if (message !== null && typeof message.refusal === 'string' && message.refusal.length > 0) {
    return { kind: 'refused', text, usage }
  }

  const finish = choice.finish_reason
  if (finish === 'length') return { kind: 'truncated', text, usage }
  if (finish === 'content_filter') return { kind: 'refused', text, usage }
  if (finish === 'stop') return { kind: 'complete', text, usage }
  throw new ProviderError('malformed_response', { status: http.status })
}

function readOpenAIUsage(raw: unknown) {
  if (!isRecord(raw)) return null
  return buildUsage(raw.prompt_tokens, raw.completion_tokens)
}

function throwOpenAIError(status: number, body: unknown, host: string): never {
  if (status === 401) throwForStatus(status, 'auth')
  if (status === 403) {
    if (isOpenRouterModeration(body, host)) throwForStatus(status, 'invalid_request')
    throwForStatus(status, 'auth')
  }
  // Documented status rows beat a body code: a 429/5xx mentioning a model is still
  // rate_limit/transient. `model_not_found` codes only reclassify other 4xx.
  if (status === 429 || status === 402) throwForStatus(status, 'rate_limit')
  if (status === 404 || (status >= 400 && status < 500 && isModelNotFound(body))) {
    throwForStatus(status, 'model_not_found')
  }
  if (status === 408 || status >= 500 || status === 498) throwForStatus(status, 'transient')
  if (status === 400 || status === 413 || status === 422) {
    throwForStatus(status, 'invalid_request')
  }
  // Family buckets cover every 4xx/5xx; out-of-range leftovers are transient.
  if (status >= 400 && status < 600) {
    throwForStatus(status, classifyByStatusFamily(status))
  }
  throwForStatus(status, 'transient')
}

function isModelNotFound(body: unknown): boolean {
  if (!isRecord(body)) return false
  const error = body.error
  if (!isRecord(error)) return false
  return error.code === 'model_not_found' || error.type === 'model_not_found'
}

function isOpenRouterModeration(body: unknown, host: string): boolean {
  if (!host.includes('openrouter')) return false
  return openRouterErrorType(body) === 'moderation'
}

function openRouterErrorType(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const fromChoice = firstChoiceError(body)
  const error = fromChoice ?? (isRecord(body.error) ? body.error : null)
  if (error === null) return undefined
  const meta = isRecord(error.metadata) ? error.metadata : null
  if (meta !== null) {
    if (typeof meta.error_type === 'string') return meta.error_type
    if (typeof meta.code === 'string') return meta.code
  }
  if (typeof error.code === 'string') return error.code
  if (typeof error.type === 'string') return error.type
  return undefined
}

function firstChoiceError(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.choices) || body.choices.length === 0) return null
  const first: unknown = body.choices[0]
  if (!isRecord(first) || !isRecord(first.error)) return null
  return first.error
}

function classifyEmbeddedError(
  body: Record<string, unknown>,
  host: string,
): {
  kind: 'refused' | 'auth' | 'rate_limit' | 'transient'
  status?: number
  message?: string
} | null {
  if (!host.includes('openrouter')) return null
  const choices = body.choices
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null
  const hasErrorFinish = choice?.finish_reason === 'error'
  const topError = isRecord(body.error) ? body.error : null
  const choiceError = choice !== null && isRecord(choice.error) ? choice.error : null
  if (!hasErrorFinish && topError === null && choiceError === null) return null

  const type = openRouterErrorType(body)
  if (type === 'moderation') return { kind: 'refused', message: 'moderation' }
  if (type === 'auth' || type === 'authentication') return { kind: 'auth' }
  if (type === 'credit' || type === 'rate_limit' || type === 'rate-limit') {
    return { kind: 'rate_limit' }
  }
  return { kind: 'transient' }
}
