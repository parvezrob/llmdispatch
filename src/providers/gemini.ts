/**
 * Gemini generateContent adapter (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ApiKeyResolver,
  ContentPart,
  ImageOptions,
  PreparedProvider,
  Provider,
  ProviderImage,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../types'
import {
  asTokenCount,
  buildUsage,
  classifyByStatusFamily,
  fetchJson,
  GENERATED_IMAGE_MEDIA_TYPES,
  isRecord,
  isWireBase64,
  MAX_GENERATED_IMAGE_CHARACTERS,
  MAX_GENERATED_IMAGES,
  throwForStatus,
} from './transport'

const HOST = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Every finish reason that means the model declined (§5c). The three `IMAGE_*` reasons only
 * arise in image mode, and a text run that ever saw one would mean the same thing.
 */
const REFUSED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'ESCALATION',
  'LANGUAGE',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
])

/** The one classification this adapter throws for a response it cannot read (§5c). */
function malformed(status: number): never {
  throw new ProviderError('malformed_response', { status })
}

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

/**
 * One `parts` entry per content part, in order (§5c). ProtoJSON accepts `inlineData` and
 * `mimeType` too; the snake_case spelling the REST examples print is the pinned one.
 */
function geminiParts(parts: readonly ContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text }
    return { inline_data: { mime_type: part.mediaType, data: part.data } }
  })
}

async function completeGemini(apiKey: string, req: ProviderRequest): Promise<ProviderResponse> {
  const image = req.responseFormat.type === 'image' ? req.responseFormat : null
  // No model in this image family produces an alpha channel (§5c), so the one knob the wire
  // cannot express is rejected before any network call; the quota slot is still consumed.
  if (image?.background === 'transparent') {
    throw new ProviderError('invalid_request', {
      message: 'transparent background is not supported',
    })
  }
  const url = `${HOST}/models/${encodeURIComponent(req.model)}:generateContent`
  const generationConfig: Record<string, unknown> = {}
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.responseFormat.type === 'json' && req.responseFormat.topLevel === 'object') {
    generationConfig.responseMimeType = 'application/json'
  }
  if (image !== null) addImageConfig(generationConfig, image)

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: geminiParts(req.parts) }],
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

  if (!isRecord(http.body)) malformed(http.status)

  const usage = readGeminiUsage(http.body.usageMetadata, image !== null)
  const feedback = isRecord(http.body.promptFeedback) ? http.body.promptFeedback : null
  if (feedback?.blockReason != null) return { kind: 'refused', text: '', usage }

  const raw: unknown = http.body.candidates
  if (!Array.isArray(raw) || raw.length === 0) malformed(http.status)
  const candidates = raw as readonly unknown[]
  if (image !== null) return readImageResponse(candidates, usage, http.status)

  // Text and JSON mode read one candidate, as they always have: `candidateCount` is an
  // image-mode field, so nothing else can ask for more than one.
  const first: unknown = candidates[0]
  if (!isRecord(first)) malformed(http.status)
  const text = readGeminiText([first])
  const finish = first.finishReason

  if (finish === 'MAX_TOKENS') return { kind: 'truncated', text, usage }
  if (typeof finish === 'string' && REFUSED_REASONS.has(finish)) {
    return { kind: 'refused', text, usage }
  }
  if (finish === 'STOP') return { kind: 'complete', text, usage }
  malformed(http.status)
}

/** The image-mode request fields (§5c): the modalities always, each knob only when set. */
function addImageConfig(generationConfig: Record<string, unknown>, image: ImageOptions): void {
  generationConfig.responseModalities = ['TEXT', 'IMAGE']
  const imageConfig: Record<string, unknown> = {}
  if (image.aspectRatio !== undefined) imageConfig.aspectRatio = image.aspectRatio
  if (image.size !== undefined) imageConfig.imageSize = image.size
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig
  if (image.count !== undefined) generationConfig.candidateCount = image.count
}

/**
 * Image mode (§5c): every candidate's finish reason is read before any content, under one
 * precedence over all of them. A `STOP` candidate contributes its images and its text; a
 * `NO_IMAGE` candidate contributes nothing, so an all-`NO_IMAGE` response is complete with
 * no images and the core records the output rejection. With one candidate the precedence
 * reduces to the text-mode rule, apart from the content requirement in `readGeminiImages`
 * and the `NO_IMAGE` reason, neither of which has a text-mode counterpart.
 */
function readImageResponse(
  candidates: readonly unknown[],
  usage: TokenUsage | null,
  status: number,
): ProviderResponse {
  const records: Record<string, unknown>[] = []
  let refused = false
  let truncated = false
  let unmappable = false
  for (const candidate of candidates) {
    // A candidate that is not a record states no reason this adapter can map, so it weighs
    // like an unknown reason. Settling the response on it would turn a terminal refusal
    // beside it into a fallback-eligible malformed one.
    if (!isRecord(candidate)) {
      unmappable = true
      continue
    }
    records.push(candidate)
    const finish = candidate.finishReason
    if (typeof finish === 'string' && REFUSED_REASONS.has(finish)) refused = true
    else if (finish === 'MAX_TOKENS') truncated = true
    else if (finish !== 'STOP' && finish !== 'NO_IMAGE') unmappable = true
  }
  // A refusal or a truncation carries text only, so every candidate's text goes with it.
  if (refused) return { kind: 'refused', text: readGeminiText(records), usage }
  if (truncated) return { kind: 'truncated', text: readGeminiText(records), usage }
  if (unmappable) malformed(status)
  const contributing = records.filter((candidate) => candidate.finishReason === 'STOP')
  const images = readGeminiImages(contributing, status)
  return { kind: 'complete', text: readGeminiText(contributing), images, usage }
}

/**
 * Every inline image part of the contributing candidates, in order, without dimensions: the
 * core reads those from the image header (§3 point 4b). ProtoJSON prints the camelCase
 * spelling on output and accepts the snake_case one, so `inlineData` is read when present
 * and `inline_data` otherwise. Anything else on an inline part is a response this adapter
 * cannot map, and so is a contributing candidate with no readable `content.parts`: a
 * candidate that said `STOP` and then stated no content is a shape failure, not an answer
 * with nothing in it.
 *
 * The §3 point 4b caps are read here too, before the grammar: the core would reject the same
 * response, but only after this adapter had scanned every oversized string it holds.
 */
function readGeminiImages(
  candidates: readonly Record<string, unknown>[],
  status: number,
): ProviderImage[] {
  const images: ProviderImage[] = []
  for (const candidate of candidates) {
    const content = isRecord(candidate.content) ? candidate.content : null
    if (content === null || !Array.isArray(content.parts)) malformed(status)
    for (const part of content.parts as readonly unknown[]) {
      if (!isRecord(part)) malformed(status)
      const inline = part.inlineData === undefined ? part.inline_data : part.inlineData
      if (inline === undefined) continue
      if (!isRecord(inline)) malformed(status)
      const mediaType = inline.mimeType === undefined ? inline.mime_type : inline.mimeType
      const data: unknown = inline.data
      if (typeof mediaType !== 'string' || !GENERATED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        malformed(status)
      }
      if (images.length >= MAX_GENERATED_IMAGES) malformed(status)
      if (typeof data === 'string' && data.length > MAX_GENERATED_IMAGE_CHARACTERS) {
        malformed(status)
      }
      if (!isWireBase64(data)) malformed(status)
      images.push({ mediaType: mediaType as ProviderImage['mediaType'], data })
    }
  }
  return images
}

/** One candidate's `content.parts`, or none when it carries no readable content. */
function candidateParts(candidate: Record<string, unknown>): readonly unknown[] {
  const content = isRecord(candidate.content) ? candidate.content : null
  if (content === null || !Array.isArray(content.parts)) return []
  return content.parts as readonly unknown[]
}

/** The text parts of the given candidates, in order, concatenated (§5c). */
function readGeminiText(candidates: readonly Record<string, unknown>[]): string {
  const chunks: string[] = []
  for (const candidate of candidates) {
    for (const part of candidateParts(candidate)) {
      if (isRecord(part) && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('')
}

/**
 * Usage (§5c). The image split is read in image mode only: a text or JSON operation cannot
 * produce images, so letting its response report one would hand the wire the choice of
 * pricing basis for an attempt that has no images to price.
 */
function readGeminiUsage(raw: unknown, imageMode: boolean): TokenUsage | null {
  if (!isRecord(raw)) return null
  const usage = buildUsage(
    raw.promptTokenCount,
    raw.candidatesTokenCount,
    [],
    [raw.thoughtsTokenCount],
  )
  if (usage === null || !imageMode) return usage
  const imageOutputTokens = readImageTokens(raw.candidatesTokensDetails)
  if (imageOutputTokens === null || imageOutputTokens > usage.outputTokens) return usage
  return { ...usage, imageOutputTokens }
}

/**
 * The image share of the output tokens (§5c): the first `candidatesTokensDetails` entry
 * reporting the `IMAGE` modality. An entry that is not a count leaves the split absent, the
 * way an absent entry does, so the core prices the attempt with no image rate rather than
 * with a guessed one.
 */
function readImageTokens(details: unknown): number | null {
  if (!Array.isArray(details)) return null
  for (const entry of details as readonly unknown[]) {
    if (!isRecord(entry) || entry.modality !== 'IMAGE') continue
    return asTokenCount(entry.tokenCount)
  }
  return null
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
