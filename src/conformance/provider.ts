/**
 * Provider conformance suite: mandatory success plus optional classification scenarios
 * (spec §6b / §8).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type {
  ConformanceResult,
  Provider,
  ProviderErrorKind,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../types'

/** Optional classification scenarios the harness can drive when the adopter supplies them. */
type OptionalScenario =
  | 'auth'
  | 'rate_limit'
  | 'model_not_found'
  | 'invalid_request'
  | 'transient'
  | 'malformed_response'
  | 'truncated'
  | 'refused'

const OPTIONAL: readonly OptionalScenario[] = [
  'auth',
  'rate_limit',
  'model_not_found',
  'invalid_request',
  'transient',
  'malformed_response',
  'truncated',
  'refused',
]

/**
 * Optional media scenarios: success-class conditions dispatching their own request, one
 * carrying a file of the named class or, for `image_output`, asking for images back.
 */
type MediaScenario = 'document' | 'image' | 'image_output'

const MEDIA: readonly MediaScenario[] = ['document', 'image', 'image_output']

/** What each media scenario's request has to carry, in the words its failure message uses. */
const MEDIA_EXPECTATION: Readonly<Record<MediaScenario, string>> = {
  document: "an 'application/pdf' file part",
  image: 'an image file part',
  image_output: "responseFormat.type 'image'",
}

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+$/
const TRAILING_PADDING = /={1,2}$/

/** Controls that let the suite verify responseFormat and capability without guessing. */
export interface ProviderConformanceControls {
  /** Declares whether the provider under test supports native JSON mode. */
  jsonCapability?: 'native' | 'prompt-only'
  /** Observes each request the harness dispatches. */
  observeRequest?: (req: ProviderRequest) => void
}

/**
 * Checks a `Provider` against the behaviour spec §8 requires of one.
 *
 * `success` is mandatory. Absent optional scenarios are reported in `skipped` (unverified).
 * A media scenario also needs its request in `requests`; either half absent and it is skipped.
 * `passed` is true exactly when `failures` is empty.
 */
export async function runProviderConformance(opts: {
  provider: Provider
  requestFactory: () => ProviderRequest
  scenarios: { success: () => Promise<void> } & Partial<
    Record<OptionalScenario | MediaScenario, () => Promise<void>>
  >
  requests?: Partial<Record<MediaScenario, () => ProviderRequest>>
  controls?: ProviderConformanceControls
}): Promise<ConformanceResult> {
  const failures: string[] = []
  const skipped: string[] = []

  const dispatch = async (req: ProviderRequest): Promise<ProviderResponse> => {
    opts.controls?.observeRequest?.(req)
    const prepared = opts.provider.prepare ? await opts.provider.prepare() : null
    const complete =
      prepared?.complete.bind(prepared) ?? opts.provider.complete.bind(opts.provider)
    return complete(req)
  }

  try {
    await opts.scenarios.success()
    const req = opts.requestFactory()
    const response = await dispatch(req)
    assertSuccess(response, failures, 'success')
  } catch (error) {
    failures.push(`success: ${thrown(error)}`)
  }

  // Signal honour: a request whose signal is already aborted must reject as aborted.
  try {
    const controller = new AbortController()
    controller.abort()
    const req = { ...opts.requestFactory(), signal: controller.signal }
    await opts.scenarios.success()
    try {
      await dispatch(req)
      failures.push('signal: expected ProviderError(aborted) but the call succeeded')
    } catch (error) {
      if (!ProviderError.is(error) || error.kind !== 'aborted') {
        failures.push(`signal: expected ProviderError(aborted) but ${thrown(error)}`)
      }
    }
  } catch (error) {
    failures.push(`signal: ${thrown(error)}`)
  }

  // responseFormat duty when capability is declared.
  const capability = opts.controls?.jsonCapability
  if (capability === 'native') {
    try {
      await opts.scenarios.success()
      const req: ProviderRequest = {
        ...opts.requestFactory(),
        responseFormat: { type: 'json', topLevel: 'object' },
      }
      const response = await dispatch(req)
      if (response.kind === 'complete') {
        try {
          JSON.parse(response.text)
        } catch {
          failures.push(
            'responseFormat: native capability returned complete text that is not JSON',
          )
        }
      }
    } catch (error) {
      failures.push(`responseFormat: ${thrown(error)}`)
    }
  } else if (capability === 'prompt-only') {
    skipped.push('responseFormat:native')
  } else {
    skipped.push('responseFormat')
  }

  for (const name of OPTIONAL) {
    const setup = opts.scenarios[name]
    if (setup === undefined) {
      skipped.push(name)
      continue
    }
    try {
      await setup()
      const req = opts.requestFactory()
      try {
        const response = await dispatch(req)
        assertScenarioResponse(name, response, failures)
      } catch (error) {
        assertScenarioError(name, error, failures)
      }
    } catch (error) {
      failures.push(`${name}: ${thrown(error)}`)
    }
  }

  for (const name of MEDIA) {
    const setup = opts.scenarios[name]
    const requestFactory = opts.requests?.[name]
    if (setup === undefined || requestFactory === undefined) {
      skipped.push(name)
      continue
    }
    try {
      await setup()
      const req = requestFactory()
      // Guarded before dispatch: a text-only request would pass the success assertion below
      // while proving nothing about the media the scenario names.
      if (!carriesMedia(name, req)) {
        failures.push(
          `${name}: expected a request carrying ${MEDIA_EXPECTATION[name]} but it carried none`,
        )
        continue
      }
      const response = await dispatch(req)
      assertSuccess(response, failures, name)
      if (name === 'image_output') assertImages(response, failures, name)
    } catch (error) {
      failures.push(`${name}: ${thrown(error)}`)
    }
  }

  return { passed: failures.length === 0, failures, skipped }
}

/** Whether a request carries a file part of the scenario's media class (spec §6b). */
function carriesMedia(name: MediaScenario, req: ProviderRequest): boolean {
  if (name === 'image_output') return req.responseFormat.type === 'image'
  return req.parts.some(
    (part) =>
      part.type === 'file' &&
      (name === 'document'
        ? part.mediaType === 'application/pdf'
        : part.mediaType.startsWith('image/')),
  )
}

/**
 * The `ProviderImage` contract (spec §6, §8): at least one image, each with one of the three
 * raster types, §6-grammar base64, and dimensions both present as positive safe integers or
 * both absent. The core's header reader is not reachable from here, so a missing pair is
 * the adapter's right to leave, not a failure.
 */
function assertImages(response: ProviderResponse, failures: string[], label: string): void {
  if (response.kind !== 'complete') return
  const images = (response as { images?: unknown }).images
  if (!Array.isArray(images) || images.length === 0) {
    failures.push(`${label}: expected images to be a non-empty array`)
    return
  }
  // Indexed reads: a sparse slot is a missing image, not a skipped one.
  const length: number = images.length
  for (let index = 0; index < length; index++) {
    const problem = providerImageProblem((images as unknown[])[index])
    if (problem !== null) failures.push(`${label}: images[${String(index)}] ${problem}`)
  }
}

function providerImageProblem(image: unknown): string | null {
  if (typeof image !== 'object' || image === null || Array.isArray(image)) {
    return 'must be an object'
  }
  const { mediaType, data, width, height } = image as Record<string, unknown>
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) {
    return "mediaType must be 'image/png', 'image/jpeg' or 'image/webp'"
  }
  if (typeof data !== 'string' || !isBase64(data)) {
    return 'data must be non-empty standard-alphabet base64'
  }
  if (width === undefined && height === undefined) return null
  if (!isDimension(width) || !isDimension(height)) {
    return 'width and height must both be positive safe integers or both be absent'
  }
  return null
}

function isBase64(data: string): boolean {
  if (data === '' || data.length % 4 !== 0 || data.startsWith('data:')) return false
  return BASE64_ALPHABET.test(data.replace(TRAILING_PADDING, ''))
}

function isDimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function assertSuccess(response: ProviderResponse, failures: string[], label: string): void {
  if (response.kind !== 'complete') {
    failures.push(`${label}: expected kind 'complete' but was '${response.kind}'`)
    return
  }
  if (typeof response.text !== 'string') {
    failures.push(`${label}: expected string text`)
  }
  if (!usageOk(response.usage)) {
    failures.push(`${label}: usage must be TokenUsage or null with safe non-negative integers`)
  }
}

function assertScenarioResponse(
  name: OptionalScenario,
  response: ProviderResponse,
  failures: string[],
): void {
  if (name === 'truncated' || name === 'refused') {
    if (response.kind !== name) {
      failures.push(`${name}: expected kind '${name}' but was '${response.kind}'`)
    }
    if (!usageOk(response.usage)) {
      failures.push(`${name}: usage must be TokenUsage or null`)
    }
    return
  }
  if (name === 'malformed_response') {
    failures.push(`${name}: expected ProviderError(malformed_response) but got a response`)
    return
  }
  failures.push(`${name}: expected ProviderError('${name}') but got kind '${response.kind}'`)
}

function assertScenarioError(name: OptionalScenario, error: unknown, failures: string[]): void {
  if (name === 'truncated' || name === 'refused') {
    failures.push(`${name}: expected ProviderResponse.kind '${name}' but ${thrown(error)}`)
    return
  }
  const expected: ProviderErrorKind =
    name === 'malformed_response' ? 'malformed_response' : name
  if (!ProviderError.is(error) || error.kind !== expected) {
    failures.push(`${name}: expected ProviderError('${expected}') but ${thrown(error)}`)
  }
}

function usageOk(usage: TokenUsage | null): boolean {
  if (usage === null) return true
  const baseOk =
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  if (!baseOk) return false
  const split = usage.imageOutputTokens
  if (split === undefined) return true
  return Number.isSafeInteger(split) && split >= 0 && split <= usage.outputTokens
}

function thrown(error: unknown): string {
  if (ProviderError.is(error)) return `ProviderError(${error.kind})`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return `a thrown ${typeof error}`
}
