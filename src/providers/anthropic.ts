/**
 * Anthropic Messages adapter (spec §5c).
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
import { soleTextPart } from './parts'
import {
  buildUsage,
  fetchJson,
  isRecord,
  throwForStatus,
  classifyByStatusFamily,
} from './transport'

const DEFAULT_BASE = 'https://api.anthropic.com'
const VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Builds an Anthropic Messages provider. Keys resolve in `prepare()`, not at construction. */
export function anthropic(opts: { apiKey: ApiKeyResolver; baseUrl?: string }): Provider {
  const endpoint = `${normalizeBase(opts.baseUrl ?? DEFAULT_BASE)}/v1/messages`
  return {
    async prepare(): Promise<PreparedProvider> {
      const key = await opts.apiKey()
      if (key === undefined || key === '') {
        throw new Error('missing api key')
      }
      const apiKey = key
      return {
        complete(req: ProviderRequest): Promise<ProviderResponse> {
          return completeAnthropic(apiKey, endpoint, req)
        },
      }
    },
    complete(): Promise<ProviderResponse> {
      throw new ProviderError('auth', { message: 'prepare required' })
    },
  }
}

/** The user message's `content`: a plain string for a lone text part, blocks otherwise (§5c). */
function anthropicContent(parts: readonly ContentPart[]): string | unknown[] {
  const sole = soleTextPart(parts)
  if (sole !== null) return sole
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const source = { type: 'base64', media_type: part.mediaType, data: part.data }
    // PDFs are documents, every other media type is an image; neither block carries a
    // filename field, so `part.filename` has nowhere to go.
    if (part.mediaType === 'application/pdf') return { type: 'document', source }
    return { type: 'image', source }
  })
}

async function completeAnthropic(
  apiKey: string,
  endpoint: string,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: anthropicContent(req.parts) }],
  }
  if (req.temperature !== undefined) {
    body.temperature = Math.min(1, Math.max(0, req.temperature))
  }

  const http = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  if (http.status < 200 || http.status >= 300) {
    throwAnthropicError(http.status, http.body)
  }

  if (!isRecord(http.body)) {
    throw new ProviderError('malformed_response', { status: http.status })
  }

  const usage = readAnthropicUsage(http.body.usage)
  const content = http.body.content
  let text = ''
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        text = block.text
        break
      }
    }
  }

  const stop = http.body.stop_reason
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
    return { kind: 'truncated', text, usage }
  }
  if (stop === 'refusal') {
    return { kind: 'refused', text, usage }
  }
  if (stop === 'end_turn' || stop === 'stop_sequence') {
    return { kind: 'complete', text, usage }
  }
  throw new ProviderError('malformed_response', { status: http.status })
}

function readAnthropicUsage(raw: unknown) {
  if (!isRecord(raw)) return null
  return buildUsage(raw.input_tokens, raw.output_tokens, [
    raw.cache_creation_input_tokens,
    raw.cache_read_input_tokens,
  ])
}

function throwAnthropicError(status: number, body: unknown): never {
  const type = anthropicErrorType(body)
  if (type === 'authentication_error' || status === 401 || status === 403) {
    throwForStatus(status, 'auth')
  }
  if (type === 'not_found_error' || status === 404) {
    throwForStatus(status, 'model_not_found')
  }
  if (type === 'rate_limit_error' || status === 429) {
    throwForStatus(status, 'rate_limit')
  }
  if (type === 'overloaded_error' || status === 529 || status >= 500) {
    throwForStatus(status, 'transient')
  }
  if (type === 'invalid_request_error' || status === 400) {
    throwForStatus(status, 'invalid_request')
  }
  throwForStatus(status, classifyByStatusFamily(status))
}

function anthropicErrorType(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = body.error
  if (!isRecord(error)) return undefined
  return typeof error.type === 'string' ? error.type : undefined
}
