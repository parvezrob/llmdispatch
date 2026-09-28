/**
 * OpenAI-compatible chat.completions adapter (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ApiKeyResolver,
  ContentPart,
  PreparedProvider,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../types'
import { classifyOpenAIStatus } from './openai-errors'
import { classifyEmbeddedError, isOpenRouterModeration } from './openrouter-errors'
import { soleTextPart } from './parts'
import { buildUsage, fetchJson, isRecord, throwForStatus } from './transport'

const DEFAULT_BASE = 'https://api.openai.com/v1'

// `file.filename` is required by the file content part; a part that carries none still has
// to send something.
const DEFAULT_PDF_FILENAME = 'document.pdf'

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

/**
 * The user message's `content`: a plain string for a lone text part, content parts
 * otherwise (§5c). The media forms are pinned to OpenAI's published shapes; a compatible
 * server that lacks either answers with its own error.
 */
function openAIContent(parts: readonly ContentPart[]): string | unknown[] {
  const sole = soleTextPart(parts)
  if (sole !== null) return sole
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = `data:${part.mediaType};base64,${part.data}`
    if (part.mediaType === 'application/pdf') {
      return {
        type: 'file',
        file: { filename: part.filename ?? DEFAULT_PDF_FILENAME, file_data: url },
      }
    }
    return { type: 'image_url', image_url: { url } }
  })
}

async function completeOpenAI(
  apiKey: string,
  baseUrl: string,
  jsonMode: 'native' | 'prompt-only' | undefined,
  tokenParam: 'max_tokens' | 'max_completion_tokens' | undefined,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  // Transitional (spec §5c): this adapter maps no image wire, so an image request is
  // rejected before any network call; the quota slot the run took is still consumed.
  if (req.responseFormat.type === 'image') {
    throw new ProviderError('invalid_request', { message: 'image output is not supported' })
  }
  const host = hostOf(baseUrl)
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [{ role: 'user', content: openAIContent(req.parts) }],
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

  // Only an OpenRouter host embeds errors in a 2xx answer (§5c).
  const embedded = host.includes('openrouter') ? classifyEmbeddedError(http.body) : null
  if (embedded !== null) {
    if (embedded === 'refused') {
      return { kind: 'refused', text: '', usage }
    }
    throw new ProviderError(embedded, { status: http.status })
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

/**
 * The shared OpenAI rows (§5c), plus the one this transport adds for an OpenRouter host:
 * OpenRouter answers a moderation block with 403, which is the content's fault rather than
 * the key's. The envelope is recognised in `openrouter-errors.ts`; whether this host speaks
 * it is decided here.
 */
function throwOpenAIError(status: number, body: unknown, host: string): never {
  if (status === 403 && host.includes('openrouter') && isOpenRouterModeration(body)) {
    throwForStatus(status, 'invalid_request')
  }
  throwForStatus(status, classifyOpenAIStatus(status, body))
}
