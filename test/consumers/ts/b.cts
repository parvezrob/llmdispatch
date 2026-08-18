// A CommonJS module: TypeScript must reach the `require` declarations of every entry point.
import root = require('llmswitch')
import postgres = require('llmswitch/postgres')
import conformance = require('llmswitch/conformance')

export const reached = [root, postgres, conformance].length

// The same closed set, reached through the `require` declarations rather than the `import`
// ones: a consumer whose types resolved to the wrong half would not compile this.
export function httpStatus(error: root.LLMSwitchError): number {
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
// not a discriminated union — so it is still `string | undefined` after this narrowing.
export function retryAfter(error: unknown): string | null {
  if (error instanceof root.LLMSwitchError && error.code === 'QUOTA_EXCEEDED') {
    return error.resetsAt ?? null
  }
  return null
}

export function classify(error: unknown): string {
  return root.ProviderError.is(error) ? error.kind : 'unclassified'
}

export const route: root.OperationRoute = { provider: 'claude', model: 'claude-sonnet-4-6' }
