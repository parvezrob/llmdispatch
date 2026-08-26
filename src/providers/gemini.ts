/**
 * Gemini generateContent adapter (spec §5c).
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

const HOST = 'https://generativelanguage.googleapis.com/v1beta'

const REFUSED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'ESCALATION',
  'LANGUAGE',
])

/** Builds a Gemini generateContent provider. Keys resolve in `prepare()`. */
export function gemini(opts: { apiKey: ApiKeyResolver }): Provider {
  return {
    async prepare(): Promise<PreparedProvider> {
      const key = await opts.apiKey()
      if (key === undefined || key === '') {
        throw new Error('missing api key')
      }
      const apiKey = key
      return {
        complete(req: ProviderRequest): Promise<ProviderResponse> {
          return completeGemini(apiKey, req)
        },
      }
    },
    complete(): Promise<ProviderResponse> {
      throw new ProviderError('auth', { message: 'prepare required' })
    },
  }
}

async function completeGemini(apiKey: string, req: ProviderRequest): Promise<ProviderResponse> {
  const url = `${HOST}/models/${encodeURIComponent(req.model)}:generateContent`
  const generationConfig: Record<string, unknown> = {}
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.responseFormat.type === 'json' && req.responseFormat.topLevel === 'object') {
    generationConfig.responseMimeType = 'application/json'
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig
  }

  const http = await fetchJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  if (http.status < 200 || http.status >= 300) {
    throwGeminiError(http.status, http.body)
  }

  if (!isRecord(http.body)) {
    throw new ProviderError('malformed_response', { status: http.status })
  }

  const feedback = isRecord(http.body.promptFeedback) ? http.body.promptFeedback : null
  if (feedback?.blockReason != null) {
    return { kind: 'refused', text: '', usage: readGeminiUsage(http.body.usageMetadata) }
  }

  const candidates = http.body.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ProviderError('malformed_response', { status: http.status })
  }
  const first: unknown = candidates[0]
  if (!isRecord(first)) {
    throw new ProviderError('malformed_response', { status: http.status })
  }
  const candidate = first

  const text = readGeminiText(candidate)
  const usage = readGeminiUsage(http.body.usageMetadata)
  const finish = candidate.finishReason

  if (finish === 'MAX_TOKENS') return { kind: 'truncated', text, usage }
  if (typeof finish === 'string' && REFUSED_REASONS.has(finish)) {
    return { kind: 'refused', text, usage }
  }
  if (finish === 'STOP') return { kind: 'complete', text, usage }
  throw new ProviderError('malformed_response', { status: http.status })
}

function readGeminiText(candidate: Record<string, unknown>): string {
  const content = isRecord(candidate.content) ? candidate.content : null
  const parts = content !== null && Array.isArray(content.parts) ? content.parts : []
  const chunks: string[] = []
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === 'string') chunks.push(part.text)
  }
  return chunks.join('')
}

function readGeminiUsage(raw: unknown) {
  if (!isRecord(raw)) return null
  return buildUsage(
    raw.promptTokenCount,
    raw.candidatesTokenCount,
    [],
    [raw.thoughtsTokenCount],
  )
}

function throwGeminiError(status: number, body: unknown): never {
  const statusString = geminiStatusString(body)
  if (status === 401 || status === 403) throwForStatus(status, 'auth')
  if (status === 404) throwForStatus(status, 'model_not_found')
  if (status === 429 || statusString === 'RESOURCE_EXHAUSTED') {
    throwForStatus(status, 'rate_limit')
  }
  if (status === 500 || status === 503) throwForStatus(status, 'transient')
  if (status === 400 || statusString === 'INVALID_ARGUMENT') {
    throwForStatus(status, 'invalid_request')
  }
  throwForStatus(status, classifyByStatusFamily(status))
}

function geminiStatusString(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = isRecord(body.error) ? body.error : null
  if (error === null) return undefined
  return typeof error.status === 'string' ? error.status : undefined
}
