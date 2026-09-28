/**
 * OpenRouter Image API adapter (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ApiKeyResolver,
  GeneratedImageMediaType,
  ImageOptions,
  PreparedProvider,
  Provider,
  ProviderImage,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../types'
import { classifyOpenAIStatus } from './openai-errors'
import { classifyEmbeddedError, isOpenRouterModeration } from './openrouter-errors'
import { imagePrompt, isTextPart } from './parts'
import {
  buildUsage,
  fetchJson,
  GENERATED_IMAGE_MEDIA_TYPES,
  isRecord,
  isWireBase64,
  MAX_GENERATED_IMAGE_CHARACTERS,
  MAX_GENERATED_IMAGES,
  throwForStatus,
} from './transport'

const DEFAULT_BASE = 'https://openrouter.ai/api/v1'

/**
 * What the body says about billing (§5c): the usage, and the provider's own charge only when
 * it is one the core would take (§7). The property is left out rather than set to
 * `undefined` when the body reports no such charge.
 */
interface Billing {
  usage: TokenUsage | null
  costUsd?: number
}

/** What the adapter throws for a request its wire cannot express, before any fetch (§5c). */
function invalid(message: string): never {
  throw new ProviderError('invalid_request', { message })
}

/** The one classification this adapter throws for a response it cannot read (§5c). */
function malformed(status: number): never {
  throw new ProviderError('malformed_response', { status })
}

/** Builds an OpenRouter Image API provider. Keys resolve in `prepare()`. */
export function openrouterImages(opts: { apiKey: ApiKeyResolver; baseUrl?: string }): Provider {
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
          return completeImages(apiKey, baseUrl, req)
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

async function completeImages(
  apiKey: string,
  baseUrl: string,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  const { image, prompt } = readImageGate(req)
  const http = await fetchJson(`${baseUrl}/images`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(imageBody(req.model, prompt, image)),
    signal: req.signal,
  })

  if (http.status < 200 || http.status >= 300) throwImagesError(http.status, http.body)
  if (!isRecord(http.body)) malformed(http.status)
  return readImagesResponse(http.body, http.status)
}

/**
 * The two gates (§5c), in order, both before any fetch: the endpoint makes only images, and
 * it takes no reference images or documents here. What passes is the image block and the
 * prompt. Each knob travels in its own field, so no pair of them needs a gate.
 */
function readImageGate(req: ProviderRequest): { image: ImageOptions; prompt: string } {
  // 1. The endpoint makes only images.
  if (req.responseFormat.type !== 'image') invalid('only image output is supported')
  const image = req.responseFormat
  // 2. It takes no reference images or documents: every part is text.
  const parts = req.parts
  if (!parts.every(isTextPart)) invalid('file parts are not supported')
  return { image, prompt: imagePrompt(parts) }
}

/**
 * The request body (§5c): `model` and `prompt` always, each knob in its own field only when
 * set, every value verbatim. Nothing else is sent: no `quality`, `output_format`, `seed`,
 * `stream` or `provider`, and a request's `maxOutputTokens` and `temperature` have no field
 * on this wire.
 */
function imageBody(
  model: string,
  prompt: string,
  image: ImageOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt }
  if (image.count !== undefined) body.n = image.count
  if (image.aspectRatio !== undefined) body.aspect_ratio = image.aspectRatio
  if (image.size !== undefined) body.resolution = image.size
  if (image.background !== undefined) body.background = image.background
  return body
}

/**
 * A non-2xx answer (§5c): the OpenRouter rule `openaiCompatible` applies to an OpenRouter
 * host, for every base URL here, since this factory speaks OpenRouter's envelope by
 * definition. A 403 whose body is a moderation envelope is the content's fault,
 * `invalid_request`; every other answer classifies by the shared status rows.
 */
function throwImagesError(status: number, body: unknown): never {
  if (status === 403 && isOpenRouterModeration(body)) throwForStatus(status, 'invalid_request')
  throwForStatus(status, classifyOpenAIStatus(status, body))
}

/**
 * A 2xx body (§5c). Images win: a non-empty `data` array is the answer, read by the element
 * rules, and an error embedded beside it is not consulted, since OpenRouter bills an image
 * call all or nothing and answers a failed generation with a 502 it does not bill. Only
 * without images is an embedded error read: moderation is a refusal that keeps the body's
 * usage and reported cost, and any other kind is thrown with the HTTP status. After that,
 * `data` must be an array, and an empty one is a complete answer with no images, which the
 * core records as the output rejection. There is never any text.
 */
function readImagesResponse(body: Record<string, unknown>, status: number): ProviderResponse {
  const billing = readBilling(body.usage)
  const data: unknown = body.data
  if (Array.isArray(data) && data.length > 0) {
    return { kind: 'complete', text: '', images: readImagesData(data, status), ...billing }
  }
  const embedded = classifyEmbeddedError(body)
  if (embedded === 'refused') return { kind: 'refused', text: '', ...billing }
  if (embedded !== null) throw new ProviderError(embedded, { status })
  if (!Array.isArray(data)) malformed(status)
  return { kind: 'complete', text: '', images: [], ...billing }
}

/**
 * Every `data[]` element, in order (§5c), as one `ProviderImage` with no dimensions: the
 * core reads them from the header. The §3 point 4b caps come before the grammar: the count
 * before any element is read, as in the core, and each length before its scan. The media
 * type, a set lookup, is checked before the scan too, so an answer in a type the core
 * cannot take costs no scan either.
 */
function readImagesData(data: readonly unknown[], status: number): ProviderImage[] {
  if (data.length > MAX_GENERATED_IMAGES) malformed(status)
  const images: ProviderImage[] = []
  for (const element of data) {
    if (!isRecord(element)) malformed(status)
    const encoded: unknown = element.b64_json
    if (typeof encoded !== 'string') malformed(status)
    if (encoded.length > MAX_GENERATED_IMAGE_CHARACTERS) malformed(status)
    const mediaType: unknown = element.media_type
    if (!isGeneratedMediaType(mediaType)) malformed(status)
    if (!isWireBase64(encoded)) malformed(status)
    images.push({ mediaType, data: encoded })
  }
  return images
}

/**
 * Whether a `media_type` is one of the three raster types (§6). Anything else, an SVG from a
 * vector model included, is not an image the core can take.
 */
function isGeneratedMediaType(value: unknown): value is GeneratedImageMediaType {
  return typeof value === 'string' && GENERATED_IMAGE_MEDIA_TYPES.has(value)
}

/**
 * Usage and reported cost (§5c), both from the `usage` object. `prompt_tokens` and
 * `completion_tokens` are required and the image share is never split out, since the API
 * does not report one. `usage.cost` is the attempt's cost only as a finite non-negative
 * number, and it is read even when the counters are not valid, so a reported charge still
 * prices the attempt.
 */
function readBilling(raw: unknown): Billing {
  if (!isRecord(raw)) return { usage: null }
  const usage = buildUsage(raw.prompt_tokens, raw.completion_tokens)
  const costUsd = reportedCost(raw.cost)
  return costUsd === undefined ? { usage } : { usage, costUsd }
}

/** §7: a reported cost counts only as a finite non-negative number; `-0` reads as `0`. */
function reportedCost(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value === 0 ? 0 : value
}
