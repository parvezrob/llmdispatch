// An ES module: TypeScript must reach the `import` declarations of every entry point.
import * as conformance from 'llmswitch/conformance'
import * as postgres from 'llmswitch/postgres'
import * as root from 'llmswitch'
import { LLMSwitchError, ProviderError, type OperationRoute } from 'llmswitch'

export const reached = [root, postgres, conformance].length

// The codes are a closed set, and this is what says so from outside the package: every one
// of them is handled, and the `never` in the default arm refuses anything that is not on
// the list. A code added to — or removed from — the union stops this file compiling.
export function httpStatus(error: LLMSwitchError): number {
  switch (error.code) {
    case 'INVALID_INPUT':
      return 400
    case 'MISSING_SUBJECT':
      return 500
    case 'QUOTA_EXCEEDED':
      return 429
    case 'CONFIG_STORE_UNAVAILABLE':
    case 'USAGE_STORE_UNAVAILABLE':
      return 503
    case 'INVALID_CONFIG':
      return 500
    case 'ABORTED':
      return 499
    case 'PROVIDER_FAILED':
    case 'OUTPUT_REJECTED':
      return 502
    default: {
      const unhandled: never = error.code
      return unhandled
    }
  }
}

// `resetsAt` is optional on the class as a whole rather than tied to a code — the error is
// not a discriminated union — so it is still `string | undefined` after this narrowing, and
// the caller has to say what to do when it is absent.
export function retryAfter(error: unknown): string | null {
  if (error instanceof LLMSwitchError && error.code === 'QUOTA_EXCEEDED') {
    return error.resetsAt ?? null
  }
  return null
}

export function classify(error: unknown): string {
  return ProviderError.is(error) ? error.kind : 'unclassified'
}

export const route: OperationRoute = { provider: 'claude', model: 'claude-sonnet-4-6' }
