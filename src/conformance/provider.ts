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

/** Optional media scenarios: success-class conditions dispatching a request that carries a file. */
type MediaScenario = 'document' | 'image'

const MEDIA: readonly MediaScenario[] = ['document', 'image']

/** What each media scenario's request has to carry, in the words its failure message uses. */
const MEDIA_EXPECTATION: Readonly<Record<MediaScenario, string>> = {
  document: "an 'application/pdf' file part",
  image: 'an image file part',
}

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
      assertSuccess(await dispatch(req), failures, name)
    } catch (error) {
      failures.push(`${name}: ${thrown(error)}`)
    }
  }

  return { passed: failures.length === 0, failures, skipped }
}

/** Whether a request carries a file part of the scenario's media class (spec §6b). */
function carriesMedia(name: MediaScenario, req: ProviderRequest): boolean {
  return req.parts.some(
    (part) =>
      part.type === 'file' &&
      (name === 'document'
        ? part.mediaType === 'application/pdf'
        : part.mediaType.startsWith('image/')),
  )
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
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  )
}

function thrown(error: unknown): string {
  if (ProviderError.is(error)) return `ProviderError(${error.kind})`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return `a thrown ${typeof error}`
}
