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
  ProviderSvg,
  SvgOptions,
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
  MAX_GENERATED_SVG_CHARACTERS,
  MAX_GENERATED_SVG_RESPONSE_CHARACTERS,
  MAX_GENERATED_SVGS,
  throwForStatus,
} from './transport'

const DEFAULT_BASE = 'https://openrouter.ai/api/v1'

/** The one media type a vector model answers with, and the only one an svg request takes (§5c). */
const SVG_MEDIA_TYPE = 'image/svg+xml'

/** The two request formats this wire carries (§5c): raster images and SVG documents. */
type VisualFormat = Extract<ProviderRequest['responseFormat'], { type: 'image' | 'svg' }>

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
  const { format, prompt } = readGate(req)
  const http = await fetchJson(`${baseUrl}/images`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody(req.model, prompt, format)),
    signal: req.signal,
  })

  if (http.status < 200 || http.status >= 300) throwImagesError(http.status, http.body)
  if (!isRecord(http.body)) malformed(http.status)
  return readImagesResponse(http.body, http.status, format.type)
}

/**
 * The two gates (§5c), in order, both before any fetch: the endpoint makes only raster
 * images and SVG documents, and it takes no reference images or documents here. What passes
 * is the image or svg block and the prompt. Each knob travels in its own field, so no pair
 * of them needs a gate.
 */
function readGate(req: ProviderRequest): { format: VisualFormat; prompt: string } {
  // 1. The endpoint makes only images and SVG documents.
  const format = req.responseFormat
  if (format.type !== 'image' && format.type !== 'svg') {
    invalid('only image or svg output is supported')
  }
  // 2. It takes no reference images or documents: every part is text.
  const parts = req.parts
  if (!parts.every(isTextPart)) invalid('file parts are not supported')
  return { format, prompt: imagePrompt(parts) }
}

/** The request body for the format that passed the gate (§5c). */
function requestBody(
  model: string,
  prompt: string,
  format: VisualFormat,
): Record<string, unknown> {
  return format.type === 'svg'
    ? svgBody(model, prompt, format)
    : imageBody(model, prompt, format)
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
 * The svg request body (§5c): `model`, `prompt` and `output_format: 'svg'` always, which
 * only a vectorization model accepts; then `n` from `count` and `aspect_ratio` from
 * `aspectRatio`, each only when set and each verbatim. An svg block has no size or
 * background, so `resolution` and `background` are never sent, nor is anything the image
 * body leaves out.
 */
function svgBody(model: string, prompt: string, svg: SvgOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt, output_format: 'svg' }
  if (svg.count !== undefined) body.n = svg.count
  if (svg.aspectRatio !== undefined) body.aspect_ratio = svg.aspectRatio
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
 * A 2xx body (§5c), the same for both formats. Images win: a non-empty `data` array is the
 * answer, read by the element rules of the requested format, and an error embedded beside
 * it is not consulted, since OpenRouter bills an image call all or nothing and answers a
 * failed generation with a 502 it does not bill. Only without images is an embedded error
 * read: moderation is a refusal that keeps the body's usage and reported cost, and any other
 * kind is thrown with the HTTP status. After that, `data` must be an array, and an empty one
 * is a complete answer with no images or no svgs, which the core records as the output
 * rejection. There is never any text.
 */
function readImagesResponse(
  body: Record<string, unknown>,
  status: number,
  format: VisualFormat['type'],
): ProviderResponse {
  const billing = readBilling(body.usage)
  const data: unknown = body.data
  if (Array.isArray(data) && data.length > 0) return readAnswer(data, status, format, billing)
  const embedded = classifyEmbeddedError(body)
  if (embedded === 'refused') return { kind: 'refused', text: '', ...billing }
  if (embedded !== null) throw new ProviderError(embedded, { status })
  if (!Array.isArray(data)) malformed(status)
  return readAnswer([], status, format, billing)
}

/**
 * A complete answer in the requested format (§5c): an image request carries `images` and
 * never `svgs`, an svg request `svgs` and never `images`.
 */
function readAnswer(
  data: readonly unknown[],
  status: number,
  format: VisualFormat['type'],
  billing: Billing,
): ProviderResponse {
  if (format === 'svg') {
    return { kind: 'complete', text: '', svgs: readSvgData(data, status), ...billing }
  }
  return { kind: 'complete', text: '', images: readImagesData(data, status), ...billing }
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
 * Every `data[]` element of an svg answer, in order (§5c), as one `ProviderSvg`. The three
 * §3 point 4c caps and the media type are read for every element before any grammar scan:
 * the count before any element is read, then, element by element, its length and the
 * running total across the response, so an oversized answer costs length reads only. Only
 * `image/svg+xml` is taken; a raster type, or none, is not what was asked for. The document
 * check itself is the core's (§3 point 4c), not repeated here.
 */
function readSvgData(data: readonly unknown[], status: number): ProviderSvg[] {
  if (data.length > MAX_GENERATED_SVGS) malformed(status)
  const documents: string[] = []
  let total = 0
  for (const element of data) {
    if (!isRecord(element)) malformed(status)
    const encoded: unknown = element.b64_json
    if (typeof encoded !== 'string') malformed(status)
    if (encoded.length > MAX_GENERATED_SVG_CHARACTERS) malformed(status)
    total += encoded.length
    if (total > MAX_GENERATED_SVG_RESPONSE_CHARACTERS) malformed(status)
    if (element.media_type !== SVG_MEDIA_TYPE) malformed(status)
    documents.push(encoded)
  }
  const svgs: ProviderSvg[] = []
  for (const encoded of documents) {
    if (!isWireBase64(encoded)) malformed(status)
    svgs.push({ mediaType: SVG_MEDIA_TYPE, data: encoded })
  }
  return svgs
}

/**
 * Whether a `media_type` is one of the three raster types (§6). Anything else, an SVG from a
 * vector model included, is not an image the core can take: an image request never accepts
 * an SVG.
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
