import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  LLMSwitchError,
  ProviderError,
  aborted,
  configStoreUnavailable,
  invalidConfigLocal,
  invalidConfigProvider,
  invalidConfigTransientPrepare,
  invalidInput,
  missingSubject,
  outputRejected,
  providerFailed,
  quotaExceeded,
  usageStoreUnavailable,
} from '../../src/errors'
import type { OutputRejectionKind, ProviderFailureKind } from '../../src/errors/factories'
import type { AttemptRecord, ProviderErrorKind } from '../../src/types'

/** The brand is looked up the same way the class installs it: from the global registry. */
const brand = Symbol.for('llmswitch.ProviderError')

const attempts: AttemptRecord[] = [
  {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    outcome: 'transient',
    status: 503,
    usage: null,
    costUsd: null,
    durationMs: 120,
  },
]

describe('the codes raised before dispatch', () => {
  // Spec §5b, "Pre-dispatch codes". One row per code, with the literal the table gives it.
  const rows = [
    { code: 'INVALID_INPUT', retryable: false, error: () => invalidInput('summarize', 'text') },
    { code: 'MISSING_SUBJECT', retryable: false, error: () => missingSubject('summarize') },
    {
      code: 'QUOTA_EXCEEDED',
      retryable: false,
      error: () => quotaExceeded('summarize', '2026-01-16T00:00:00.000Z'),
    },
    {
      code: 'USAGE_STORE_UNAVAILABLE',
      retryable: true,
      error: () => usageStoreUnavailable('summarize', new Error('connection reset')),
    },
    {
      code: 'CONFIG_STORE_UNAVAILABLE',
      retryable: true,
      error: () => configStoreUnavailable('summarize', new Error('connection reset')),
    },
    {
      code: 'INVALID_CONFIG',
      retryable: false,
      error: () => invalidConfigLocal('summarize', 'route.provider'),
    },
    {
      code: 'INVALID_CONFIG',
      retryable: true,
      error: () => invalidConfigTransientPrepare('summarize', new ProviderError('transient')),
    },
    { code: 'ABORTED', retryable: false, error: () => aborted('summarize') },
  ] as const

  for (const row of rows) {
    it(`reports ${row.code} as retryable ${String(row.retryable)}`, () => {
      const error = row.error()
      expect(error).toBeInstanceOf(LLMSwitchError)
      expect(error.code).toBe(row.code)
      expect(error.retryable).toBe(row.retryable)
      expect(error.operation).toBe('summarize')
    })
  }

  it('names every pre-dispatch code the classification table lists', () => {
    expect(new Set(rows.map((row) => row.code))).toEqual(
      new Set([
        'INVALID_INPUT',
        'MISSING_SUBJECT',
        'QUOTA_EXCEEDED',
        'USAGE_STORE_UNAVAILABLE',
        'CONFIG_STORE_UNAVAILABLE',
        'INVALID_CONFIG',
        'ABORTED',
      ]),
    )
  })
})

describe('the classification table for a dispatched attempt', () => {
  // Spec §5b, one entry per row that ends a run as PROVIDER_FAILED.
  const providerRows: readonly (readonly [ProviderFailureKind, boolean])[] = [
    ['transient', true],
    ['rate_limit', true],
    ['malformed_response', true],
    ['timeout', true],
    ['refused', false],
    ['invalid_request', false],
    ['provider_unclassified', false],
  ]

  for (const [kind, retryable] of providerRows) {
    it(`classifies ${kind} as PROVIDER_FAILED, retryable ${String(retryable)}`, () => {
      const error = providerFailed('summarize', kind, attempts)
      expect(error.code).toBe('PROVIDER_FAILED')
      expect(error.retryable).toBe(retryable)
      expect(error.attempts).toBe(attempts)
      expect(error.message).toContain(kind)
    })
  }

  // Spec §5b, the two rows that end a run as OUTPUT_REJECTED. Both are retryable.
  const outputRows: readonly (readonly [OutputRejectionKind, boolean])[] = [
    ['truncated', true],
    ['output_rejected', true],
  ]

  for (const [kind, retryable] of outputRows) {
    it(`classifies ${kind} as OUTPUT_REJECTED, retryable ${String(retryable)}`, () => {
      const error = outputRejected('summarize', kind, attempts)
      expect(error.code).toBe('OUTPUT_REJECTED')
      expect(error.retryable).toBe(retryable)
      expect(error.attempts).toBe(attempts)
    })
  }

  it('reports a credential or model rejection as detected by the provider', () => {
    const error = invalidConfigProvider('summarize', attempts)
    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.retryable).toBe(false)
    expect(error.detectedAt).toBe('provider')
    expect(error.attempts).toBe(attempts)
  })

  it('carries the attempts of a run aborted after it had dispatched', () => {
    expect(aborted('summarize', attempts).attempts).toBe(attempts)
  })
})

describe('the fields an error carries', () => {
  it('marks a local configuration failure as detected locally', () => {
    expect(invalidConfigLocal('summarize', 'route.model').detectedAt).toBe('local')
    expect(
      invalidConfigTransientPrepare('summarize', new ProviderError('transient')).detectedAt,
    ).toBe('local')
  })

  it('attaches resetsAt to a quota denial and to nothing else', () => {
    expect(quotaExceeded('summarize', '2026-01-16T00:00:00.000Z').resetsAt).toBe(
      '2026-01-16T00:00:00.000Z',
    )
    expect('resetsAt' in invalidInput('summarize', 'text')).toBe(false)
  })

  it('leaves out the fields a failure has nothing to say about', () => {
    const error = missingSubject('summarize')
    expect('resetsAt' in error).toBe(false)
    expect('detectedAt' in error).toBe(false)
    expect('attempts' in error).toBe(false)
    expect('cause' in error).toBe(false)
  })

  it('chains the failure that caused a store to be unreachable', () => {
    const reset = new Error('connection reset')
    expect(usageStoreUnavailable('summarize', reset).cause).toBe(reset)
    expect(configStoreUnavailable('summarize', reset).cause).toBe(reset)
  })

  it('chains a thrown readiness failure and omits the chain when there was none', () => {
    const thrown = new ProviderError('transient', { status: 503 })
    expect(invalidConfigTransientPrepare('summarize', thrown).cause).toBe(thrown)
    expect(invalidConfigLocal('summarize', 'apiKey', { cause: thrown }).cause).toBe(thrown)
    expect('cause' in invalidConfigLocal('summarize', 'route.provider')).toBe(false)
  })

  it('chains what the caller passed even when that is undefined, as Error does', () => {
    // `new Error(m, { cause: undefined })` carries a `cause`; a caught value that turned out
    // to be undefined is still a chain the caller asked for, and losing it hides the throw.
    const store = usageStoreUnavailable('summarize', undefined)
    expect('cause' in store).toBe(true)
    expect(store.cause).toBeUndefined()

    const local = invalidConfigLocal('summarize', 'apiKey', { cause: undefined })
    expect('cause' in local).toBe(true)
    expect(local.cause).toBeUndefined()
  })

  it('names itself so a log line says which error it is', () => {
    expect(missingSubject('summarize').name).toBe('LLMSwitchError')
    expect(new ProviderError('auth').name).toBe('ProviderError')
  })

  it('says nothing about the input beyond the operation and the field', () => {
    const error = invalidInput('summarize', 'text')
    expect(error.message).toBe('invalid input for "summarize": text')
  })
})

describe('a provider error', () => {
  it('describes itself from the classification when the caller supplies no message', () => {
    expect(new ProviderError('rate_limit').message).toBe('provider error: rate_limit')
  })

  it('prefers a message the caller supplies', () => {
    expect(new ProviderError('rate_limit', { message: 'slow down' }).message).toBe('slow down')
  })

  it('keeps the status when the provider returned one', () => {
    expect(new ProviderError('rate_limit', { status: 429 }).status).toBe(429)
    expect('status' in new ProviderError('rate_limit')).toBe(false)
    expect('status' in new ProviderError('rate_limit', { message: 'slow down' })).toBe(false)
  })

  it('carries its brand on the prototype, where nothing enumerating an instance sees it', () => {
    const error = new ProviderError('auth', { status: 401 })
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
    // Object.assign copies own enumerable properties, symbols included: a brand that was
    // enumerable, or on the instance rather than the prototype, would come across here.
    expect(Object.getOwnPropertySymbols(Object.assign({}, error))).toEqual([])

    const installed = Object.getOwnPropertyDescriptor(ProviderError.prototype, brand)
    expect(installed?.value).toBe(true)
    expect(installed?.enumerable).toBe(false)
  })
})

describe('recognising a provider error', () => {
  /** A plain object carrying the brand, so the shape checks can be exercised one at a time. */
  function forge(overrides: Record<string | symbol, unknown>): unknown {
    return { [brand]: true, kind: 'transient', message: 'failed', ...overrides }
  }

  /** The same object, but reading one property throws the way a hostile value would. */
  function hostileAt(property: string | symbol): unknown {
    const base: Record<string | symbol, unknown> = {
      [brand]: true,
      kind: 'transient',
      message: 'failed',
      status: 503,
    }
    return Object.defineProperty(base, property, {
      get() {
        throw new Error('this property refuses to be read')
      },
      configurable: true,
    })
  }

  it('recognises one it made itself', () => {
    expect(ProviderError.is(new ProviderError('transient'))).toBe(true)
    expect(ProviderError.is(new ProviderError('auth', { status: 401 }))).toBe(true)
  })

  it('recognises every classification the union declares', () => {
    // An exhaustive record rather than a list: a kind added to the union without being added
    // here stops this file compiling, which is the only way the walk stays complete.
    const table = {
      transient: true,
      rate_limit: true,
      auth: true,
      model_not_found: true,
      invalid_request: true,
      aborted: true,
      malformed_response: true,
    } satisfies Record<ProviderErrorKind, true>

    const everyKind = Object.keys(table) as (keyof typeof table)[]
    expect(everyKind).toHaveLength(7)
    for (const kind of everyKind) {
      expect(ProviderError.is(new ProviderError(kind))).toBe(true)
      expect(ProviderError.is(forge({ kind }))).toBe(true)
    }
  })

  it('recognises one thrown from another realm, where instanceof cannot', () => {
    const foreign: object = runInNewContext(`
      const brand = Symbol.for('llmswitch.ProviderError')
      class ForeignProviderError extends Error {
        constructor(kind, status) {
          super('the other realm failed')
          this.kind = kind
          this.status = status
        }
      }
      Object.defineProperty(ForeignProviderError.prototype, brand, {
        value: true,
        enumerable: false,
      })
      new ForeignProviderError('rate_limit', 429)
    `) as object

    expect(foreign instanceof Error).toBe(false)
    expect(foreign instanceof ProviderError).toBe(false)
    expect(ProviderError.is(foreign)).toBe(true)
  })

  it('rejects primitives', () => {
    for (const value of [undefined, null, 0, 429, '', 'transient', true, Symbol('transient')]) {
      expect(ProviderError.is(value)).toBe(false)
    }
  })

  it('rejects an ordinary error', () => {
    expect(ProviderError.is(new Error('failed'))).toBe(false)
    expect(ProviderError.is(new TypeError('failed'))).toBe(false)
  })

  it('rejects an object that copied the brand but not the shape', () => {
    expect(ProviderError.is(forge({ kind: 'overloaded' }))).toBe(false)
    expect(ProviderError.is(forge({ kind: 42 }))).toBe(false)
    expect(ProviderError.is(forge({ message: 42 }))).toBe(false)
    expect(ProviderError.is(forge({ status: '429' }))).toBe(false)
    expect(ProviderError.is({ kind: 'transient', message: 'failed' })).toBe(false)
    expect(ProviderError.is(forge({ [brand]: 'yes' }))).toBe(false)
  })

  it('accepts an object that carries the brand and the shape, with or without a status', () => {
    expect(ProviderError.is(forge({}))).toBe(true)
    expect(ProviderError.is(forge({ status: 429 }))).toBe(true)
  })

  it('answers false rather than throwing when a property refuses to be read', () => {
    for (const property of [brand, 'kind', 'message', 'status']) {
      expect(() => ProviderError.is(hostileAt(property))).not.toThrow()
      expect(ProviderError.is(hostileAt(property))).toBe(false)
    }
  })

  it('answers false rather than throwing for a proxy that refuses everything', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('this proxy refuses to be read')
        },
      },
    )
    expect(() => ProviderError.is(hostile)).not.toThrow()
    expect(ProviderError.is(hostile)).toBe(false)
  })
})
