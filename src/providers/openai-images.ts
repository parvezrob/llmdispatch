/**
 * OpenAI Images API generations adapter (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ApiKeyResolver,
  AspectRatio,
  ContentPart,
  ImageOptions,
  ImageSize,
  PreparedProvider,
  Provider,
  ProviderImage,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../types'
import { classifyOpenAIStatus } from './openai-errors'
import {
  asTokenCount,
  buildUsage,
  fetchJson,
  isRecord,
  isWireBase64,
  MAX_GENERATED_IMAGE_CHARACTERS,
  MAX_GENERATED_IMAGES,
  throwForStatus,
} from './transport'

const DEFAULT_BASE = 'https://api.openai.com/v1'

/** The factory's `quality` option: sent verbatim when set, never defaulted (§5c). */
type Quality = Parameters<typeof openaiImages>[0]['quality']

/**
 * The pixel size sent for each size class and aspect ratio (§5c). Every cell is a multiple of
 * 16 on both sides, exactly on its ratio, and within 1:3 to 3:1. 4K is offered at 16:9 only.
 */
const PIXEL_SIZES: Readonly<Record<ImageSize, Readonly<Partial<Record<AspectRatio, string>>>>> =
  Object.freeze({
    '1K': Object.freeze({
      '1:1': '1024x1024',
      '3:2': '1536x1024',
      '2:3': '1024x1536',
      '16:9': '1536x864',
      '9:16': '864x1536',
      '4:3': '1024x768',
      '3:4': '768x1024',
    }),
    '2K': Object.freeze({
      '1:1': '2048x2048',
      '3:2': '2016x1344',
      '2:3': '1344x2016',
      '16:9': '2048x1152',
      '9:16': '1152x2048',
      '4:3': '2048x1536',
      '3:4': '1536x2048',
    }),
    '4K': Object.freeze({ '16:9': '3840x2160' }),
  })

/** A stated response size: two positive decimal integers joined by `x`, nothing else. */
const RESPONSE_SIZE = /^(\d+)x(\d+)$/

/** What the adapter throws for a request its wire cannot express, before any fetch (§5c). */
function invalid(message: string): never {
  throw new ProviderError('invalid_request', { message })
}

/** The one classification this adapter throws for a response it cannot read (§5c). */
function malformed(status: number): never {
  throw new ProviderError('malformed_response', { status })
}

/** Builds an OpenAI Images API provider. Keys resolve in `prepare()`. */
export function openaiImages(opts: {
  apiKey: ApiKeyResolver
  baseUrl?: string
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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
          return completeImages(apiKey, baseUrl, opts.quality, req)
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
  quality: Quality,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  const { image, prompt, size } = readImageGate(req)
  const http = await fetchJson(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(imageBody(req.model, prompt, image, size, quality)),
    signal: req.signal,
  })

  // A refusal is read before anything else in the body, whatever the status: the Images API
  // reports a blocked prompt as an error response, and that is a refusal (§5b), not a bad
  // request.
  if (isImageRefusal(http.body)) return { kind: 'refused', text: '', usage: null }
  if (http.status < 200 || http.status >= 300) {
    throwForStatus(http.status, classifyOpenAIStatus(http.status, http.body))
  }
  if (!isRecord(http.body)) malformed(http.status)
  return readImagesResponse(http.body, http.status)
}

/**
 * The four gates (§5c), in order, all before any fetch: the endpoint makes only images, it
 * takes no reference images or documents, its one size field needs both knobs or neither,
 * and 4K is offered at 16:9 only. What passes is the image block, the prompt, and the pixel
 * size to send, `null` when neither knob is set.
 */
function readImageGate(req: ProviderRequest): {
  image: ImageOptions
  prompt: string
  size: string | null
} {
  if (req.responseFormat.type !== 'image') invalid('only image output is supported')
  const image = req.responseFormat
  const prompt = imagePrompt(req.parts)
  const { aspectRatio, size } = image
  if (aspectRatio === undefined && size === undefined) return { image, prompt, size: null }
  if (aspectRatio === undefined || size === undefined) {
    invalid('aspectRatio and size must be set together')
  }
  if (size === '4K' && aspectRatio !== '16:9') invalid("size '4K' needs aspectRatio '16:9'")
  const pixels = pixelSize(size, aspectRatio)
  // Unreachable for the typed knobs, which the core validates; a value outside them is
  // rejected here rather than sent as a size nobody pinned.
  if (pixels === undefined) invalid('unsupported size or aspect ratio')
  return { image, prompt, size: pixels }
}

/** The text parts joined with a newline; a lone part goes verbatim, `''` included (§5c). */
function imagePrompt(parts: readonly ContentPart[]): string {
  const texts: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') invalid('file parts are not supported')
    texts.push(part.text)
  }
  return texts.join('\n')
}

/** The table cell for a class and a ratio, read as own properties only. */
function pixelSize(size: ImageSize, aspectRatio: AspectRatio): string | undefined {
  if (!Object.hasOwn(PIXEL_SIZES, size)) return undefined
  const row = PIXEL_SIZES[size]
  return Object.hasOwn(row, aspectRatio) ? row[aspectRatio] : undefined
}

/**
 * The request body (§5c): `model` and `prompt` always, every other field only when set.
 * `output_format` and `moderation` are never sent, so the provider defaults apply, and a
 * request's `maxOutputTokens` and `temperature` have no field on this wire.
 */
function imageBody(
  model: string,
  prompt: string,
  image: ImageOptions,
  size: string | null,
  quality: Quality,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt }
  if (image.count !== undefined) body.n = image.count
  if (size !== null) body.size = size
  if (image.background !== undefined) body.background = image.background
  if (quality !== undefined) body.quality = quality
  return body
}

/**
 * Whether a body is the Images API's refusal (§5c): an `error` object whose code is
 * `moderation_blocked` or the legacy `content_policy_violation`, or whose type is
 * `image_generation_user_error`.
 */
function isImageRefusal(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error)) return false
  const { code, type } = body.error
  return (
    code === 'moderation_blocked' ||
    code === 'content_policy_violation' ||
    type === 'image_generation_user_error'
  )
}

/**
 * A 2xx body (§5c): `data` must be an array; `output_format` and `size` are read once, before
 * the elements, and apply to every image. An empty `data` is a complete answer with no
 * images, which the core records as the output rejection. There is never any text.
 */
function readImagesResponse(body: Record<string, unknown>, status: number): ProviderResponse {
  const usage = readImagesUsage(body.usage)
  const data: unknown = body.data
  if (!Array.isArray(data)) malformed(status)
  const mediaType = readImageMediaType(body.output_format, status)
  const dimensions = readResponseSize(body.size)
  const images = readImagesData(data as readonly unknown[], mediaType, dimensions, status)
  return { kind: 'complete', text: '', images, usage }
}

/**
 * Every `data[]` element's `b64_json`, in order (§5c). The §3 point 4b caps are read before
 * the grammar, as in the Gemini adapter: the count before an element is taken, and the
 * length before the scan, so an oversized payload costs a length read rather than a scan the
 * core would then repeat.
 */
function readImagesData(
  data: readonly unknown[],
  mediaType: ProviderImage['mediaType'],
  dimensions: { width: number; height: number } | null,
  status: number,
): ProviderImage[] {
  const images: ProviderImage[] = []
  for (const element of data) {
    if (!isRecord(element)) malformed(status)
    if (images.length >= MAX_GENERATED_IMAGES) malformed(status)
    const encoded: unknown = element.b64_json
    if (typeof encoded !== 'string') malformed(status)
    if (encoded.length > MAX_GENERATED_IMAGE_CHARACTERS) malformed(status)
    if (!isWireBase64(encoded)) malformed(status)
    images.push(
      dimensions === null
        ? { mediaType, data: encoded }
        : { mediaType, data: encoded, ...dimensions },
    )
  }
  return images
}

/** The response's `output_format` as a media type: absent means png, the default (§5c). */
function readImageMediaType(value: unknown, status: number): ProviderImage['mediaType'] {
  if (value === undefined || value === 'png') return 'image/png'
  if (value === 'jpeg') return 'image/jpeg'
  if (value === 'webp') return 'image/webp'
  malformed(status)
}

/**
 * The response's `size` as dimensions for every image, when it states two positive safe
 * integers (§5c). Anything else, `'auto'` included, states none, and the core reads them
 * from the image header instead.
 */
function readResponseSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'string') return null
  const match = RESPONSE_SIZE.exec(value)
  if (match === null) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!isDimension(width) || !isDimension(height)) return null
  return { width, height }
}

function isDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Usage (§5c): `input_tokens` and `output_tokens` are required. The image share is read from
 * `output_tokens_details.image_tokens` when it is a count no greater than the output tokens;
 * otherwise it is left absent, since assuming the total was all images would be a guess.
 */
function readImagesUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null
  const usage = buildUsage(raw.input_tokens, raw.output_tokens)
  if (usage === null) return null
  const details = raw.output_tokens_details
  if (!isRecord(details)) return usage
  const imageOutputTokens = asTokenCount(details.image_tokens)
  if (imageOutputTokens === null || imageOutputTokens > usage.outputTokens) return usage
  return { ...usage, imageOutputTokens }
}
