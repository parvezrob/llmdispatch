/**
 * The §5b classification table composed end to end (spec 271–308): every attempt-outcome
 * row driven through `run` over its applicable fallback compositions, the flag axis on
 * exactly its two rows, per-outcome-shape assertions including the quota-effect call log,
 * and two-part completeness enforcement — an exhaustive `switch` over the
 * `ProviderErrorKind` and `AttemptOutcome` unions builds the case list (a union member
 * added later fails to compile), and the case count is pinned to a review-time inventory
 * literal a reader diffs against the spec table.
 */

import { describe, expect, it } from 'vitest'

import { LLMSwitchError, ProviderError } from '../../../src/errors'
import type {
  AttemptOutcome,
  OperationsMap,
  ProviderErrorKind,
  ProviderResponse,
} from '../../../src/types'
import type { Fixture } from '../core/helpers'
import {
  ECHO_INPUT,
  ECHO_OUTPUT,
  expectCode,
  expectSameRejection,
  fixture,
  flushMicrotasks,
  observe,
} from '../core/helpers'

const ARGS = { input: { text: 'hi' }, subjectId: 'u' }
const QUOTA = { perDay: 5 }
const TIMEOUT_MS = 1_000
const TABLE = { quota: QUOTA, timeoutMs: TIMEOUT_MS }

// ——— completeness enforcement ———

/**
 * Review-time inventory: the §5b row counts a reader diffs against the spec table. An aid
 * for the human pass — the compile-time checks below are what fail when a union moves.
 */
const INVENTORY = { attemptOutcomes: 15, providerErrorKinds: 7 }

const ATTEMPT_OUTCOMES = [
  'succeeded',
  'transient',
  'rate_limit',
  'auth',
  'model_not_found',
  'invalid_request',
  'aborted',
  'malformed_response',
  'timeout',
  'truncated',
  'refused',
  'output_rejected',
  'output_schema_error',
  'quality_error',
  'provider_unclassified',
] as const satisfies readonly AttemptOutcome[]

const PROVIDER_ERROR_KINDS = [
  'transient',
  'rate_limit',
  'auth',
  'model_not_found',
  'invalid_request',
  'aborted',
  'malformed_response',
] as const satisfies readonly ProviderErrorKind[]

// `satisfies` rejects an extra member; these aliases reject a missing one.
type OutcomesExhaustive = [Exclude<AttemptOutcome, (typeof ATTEMPT_OUTCOMES)[number]>] extends [
  never,
]
  ? true
  : never
type KindsExhaustive = [
  Exclude<ProviderErrorKind, (typeof PROVIDER_ERROR_KINDS)[number]>,
] extends [never]
  ? true
  : never
const outcomesExhaustive: OutcomesExhaustive = true
const kindsExhaustive: KindsExhaustive = true

/** Where each §5b row is asserted in this file; the switch is the completeness gate. */
type RowClass = 'success' | 'dispatched-failure' | 'abort-timing' | 'raw-unwrap'

function classify(outcome: AttemptOutcome): RowClass {
  switch (outcome) {
    case 'succeeded':
      return 'success'
    case 'transient':
    case 'rate_limit':
    case 'malformed_response':
    case 'timeout':
    case 'truncated':
    case 'output_rejected':
    case 'refused':
    case 'auth':
    case 'model_not_found':
    case 'invalid_request':
    case 'provider_unclassified':
      return 'dispatched-failure'
    case 'aborted':
      return 'abort-timing'
    case 'output_schema_error':
    case 'quality_error':
      return 'raw-unwrap'
    default: {
      // A union member added later lands here and fails to compile.
      const missing: never = outcome
      throw new Error(`§5b row not in the matrix: ${String(missing)}`)
    }
  }
}

// ——— the dispatched-failure rows ———

interface FailureRow {
  outcome: AttemptOutcome
  eligible: boolean
  code: LLMSwitchError['code']
  retryable: boolean
  detectedAt?: 'provider'
  arrange: (f: Fixture, which: 'p1' | 'p2') => void
  /** Fires the timers this row needs before the arranged attempt can end. */
  land?: (f: Fixture) => Promise<void>
}

const truncatedResponse: ProviderResponse = {
  kind: 'truncated',
  text: 'part',
  usage: { inputTokens: 1, outputTokens: 1 },
}
const refusedResponse: ProviderResponse = {
  kind: 'refused',
  text: '',
  usage: { inputTokens: 1, outputTokens: 0 },
}

/** Each row's literal terminal columns from §5b, plus how to arrange it on an attempt. */
const FAILURE_ROWS: FailureRow[] = [
  {
    outcome: 'transient',
    eligible: true,
    code: 'PROVIDER_FAILED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('transient', { status: 503 }))
    },
  },
  {
    outcome: 'rate_limit',
    eligible: true,
    code: 'PROVIDER_FAILED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('rate_limit', { status: 429 }))
    },
  },
  {
    outcome: 'malformed_response',
    eligible: true,
    code: 'PROVIDER_FAILED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('malformed_response'))
    },
  },
  {
    outcome: 'timeout',
    eligible: true,
    code: 'PROVIDER_FAILED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextHang()
    },
    land: (f) => f.runtime.advance(TIMEOUT_MS),
  },
  {
    outcome: 'truncated',
    eligible: true,
    code: 'OUTPUT_REJECTED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextResolve(truncatedResponse)
    },
  },
  {
    outcome: 'output_rejected',
    eligible: true,
    code: 'OUTPUT_REJECTED',
    retryable: true,
    arrange: (f, which) => {
      f[which].nextResolve({ kind: 'complete', text: 'not json', usage: null })
    },
  },
  {
    outcome: 'refused',
    eligible: false,
    code: 'PROVIDER_FAILED',
    retryable: false,
    arrange: (f, which) => {
      f[which].nextResolve(refusedResponse)
    },
  },
  {
    outcome: 'auth',
    eligible: false,
    code: 'INVALID_CONFIG',
    retryable: false,
    detectedAt: 'provider',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('auth', { status: 401 }))
    },
  },
  {
    outcome: 'model_not_found',
    eligible: false,
    code: 'INVALID_CONFIG',
    retryable: false,
    detectedAt: 'provider',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('model_not_found', { status: 404 }))
    },
  },
  {
    outcome: 'invalid_request',
    eligible: false,
    code: 'PROVIDER_FAILED',
    retryable: false,
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('invalid_request', { status: 413 }))
    },
  },
  {
    outcome: 'provider_unclassified',
    eligible: false,
    code: 'PROVIDER_FAILED',
    retryable: false,
    arrange: (f, which) => {
      f[which].nextReject(new Error('a plain failure'))
    },
  },
]

// ——— instruments ———

/** The quota-effect call log, reduced to its shape: reserve / commit / settle <outcome>. */
function quotaLog(f: Fixture): string[] {
  return f.s.log
    .filter(
      (line) =>
        line.startsWith('reserve') || line.startsWith('commit') || line.startsWith('settle'),
    )
    .map((line) => (line.startsWith('settle') ? line : (line.split(' ')[0] ?? line)))
}

/** Fires the row's timers (when it has any) and drains the microtask queue. */
async function landAttempt(f: Fixture, row: FailureRow): Promise<void> {
  if (row.land !== undefined) await row.land(f)
  await flushMicrotasks()
}

function asSwitchError(error: unknown, code: LLMSwitchError['code']): LLMSwitchError {
  expect(error).toBeInstanceOf(LLMSwitchError)
  const typed = error as LLMSwitchError
  expect(typed.code).toBe(code)
  return typed
}

// ——— the matrix ———

describe('completeness: the switch-built case list against the review-time inventory', () => {
  it('enumerates both unions in full and routes every row to exactly one block', () => {
    expect(outcomesExhaustive).toBe(true)
    expect(kindsExhaustive).toBe(true)
    expect(ATTEMPT_OUTCOMES).toHaveLength(INVENTORY.attemptOutcomes)
    expect(PROVIDER_ERROR_KINDS).toHaveLength(INVENTORY.providerErrorKinds)
    for (const kind of PROVIDER_ERROR_KINDS) expect(ATTEMPT_OUTCOMES).toContain(kind)

    const dispatched = ATTEMPT_OUTCOMES.filter(
      (outcome) => classify(outcome) === 'dispatched-failure',
    )
    expect([...FAILURE_ROWS.map((row) => row.outcome)].sort()).toEqual([...dispatched].sort())
    expect(ATTEMPT_OUTCOMES.filter((o) => classify(o) === 'success')).toEqual(['succeeded'])
    expect(ATTEMPT_OUTCOMES.filter((o) => classify(o) === 'abort-timing')).toEqual(['aborted'])
    expect(ATTEMPT_OUTCOMES.filter((o) => classify(o) === 'raw-unwrap')).toEqual([
      'output_schema_error',
      'quality_error',
    ])
  })
})

describe('dispatched-failure rows over the fallback axis', () => {
  for (const row of FAILURE_ROWS) {
    it(`${row.outcome}: no fallback declared -> terminal shape and quota log`, async () => {
      const f = fixture({ ...TABLE, fallback: false })
      row.arrange(f, 'p1')
      const run = observe(f.ai.run('echo', ARGS))
      await landAttempt(f, row)
      expect(run.state).toBe('rejected')
      const error = asSwitchError(run.error, row.code)
      expect(error.retryable).toBe(row.retryable)
      expect(error.detectedAt).toBe(row.detectedAt)
      expect(error.attempts?.map((a) => a.outcome)).toEqual([row.outcome])
      expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
    })

    if (row.eligible) {
      it(`${row.outcome}: fallback declared -> rescued, result shape, one slot`, async () => {
        const f = fixture(TABLE)
        row.arrange(f, 'p1')
        const run = observe(f.ai.run('echo', ARGS))
        await landAttempt(f, row)
        expect(run.state).toBe('resolved')
        const result = run.value
        expect(result?.data).toEqual({ answer: 'ok' })
        expect(result?.route).toEqual({ provider: 'p2', model: 'm2' })
        expect(result?.usedFallback).toBe(true)
        expect(result?.attempts.map((a) => a.outcome)).toEqual([row.outcome, 'succeeded'])
        expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle succeeded'])
      })

      it(`${row.outcome}: the fallback itself fails the same way -> its terminal, both attempts recorded`, async () => {
        const f = fixture(TABLE)
        row.arrange(f, 'p1')
        row.arrange(f, 'p2')
        const run = observe(f.ai.run('echo', ARGS))
        await landAttempt(f, row)
        await landAttempt(f, row)
        expect(run.state).toBe('rejected')
        const error = asSwitchError(run.error, row.code)
        expect(error.retryable).toBe(row.retryable)
        expect(error.attempts?.map((a) => a.outcome)).toEqual([row.outcome, row.outcome])
        expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
      })
    } else {
      it(`${row.outcome}: fallback declared but ineligible -> terminal, nothing dispatched to it`, async () => {
        const f = fixture(TABLE)
        row.arrange(f, 'p1')
        const run = observe(f.ai.run('echo', ARGS))
        await landAttempt(f, row)
        expect(run.state).toBe('rejected')
        const error = asSwitchError(run.error, row.code)
        expect(error.retryable).toBe(row.retryable)
        expect(error.detectedAt).toBe(row.detectedAt)
        expect(f.p2.requests.length).toBe(0)
        expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
      })
    }
  }
})

describe('the flag axis: fallbackOnAuthOrModelNotFound governs its two rows, primary only', () => {
  for (const kind of ['auth', 'model_not_found'] as const) {
    it(`${kind}: flag on -> the primary is rescued`, async () => {
      const f = fixture({ ...TABLE, config: { fallbackOnAuthOrModelNotFound: true } })
      f.p1.nextReject(new ProviderError(kind))
      const result = await f.ai.run('echo', ARGS)
      expect(result.usedFallback).toBe(true)
      expect(result.attempts.map((a) => a.outcome)).toEqual([kind, 'succeeded'])
      expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle succeeded'])
    })

    it(`${kind}: flag on, the fallback itself ends ${kind} -> terminal INVALID_CONFIG (provider); no second fallback`, async () => {
      const f = fixture({ ...TABLE, config: { fallbackOnAuthOrModelNotFound: true } })
      f.p1.nextReject(new ProviderError('transient', { status: 503 }))
      f.p2.nextReject(new ProviderError(kind))
      const error = await expectCode(f.ai.run('echo', ARGS), 'INVALID_CONFIG')
      expect(error.retryable).toBe(false)
      expect(error.detectedAt).toBe('provider')
      expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient', kind])
      expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
    })
  }

  it('the flag reaches no other ineligible row', async () => {
    const arrangements: ((f: Fixture) => void)[] = [
      (f) => {
        f.p1.nextResolve(refusedResponse)
      },
      (f) => {
        f.p1.nextReject(new ProviderError('invalid_request', { status: 413 }))
      },
    ]
    for (const arrange of arrangements) {
      const f = fixture({ ...TABLE, config: { fallbackOnAuthOrModelNotFound: true } })
      arrange(f)
      await expectCode(f.ai.run('echo', ARGS), 'PROVIDER_FAILED')
      expect(f.p2.requests.length).toBe(0)
    }
  })
})

describe("provider_unclassified's one real branch: treatUnclassifiedAsTransient", () => {
  it('on: reclassifies to transient and the fallback rescues', async () => {
    const f = fixture({ ...TABLE, config: { treatUnclassifiedAsTransient: true } })
    f.p1.nextReject(new Error('a plain failure'))
    const result = await f.ai.run('echo', ARGS)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['transient', 'succeeded'])
  })

  it("on: both attempts unclassified -> the transient row's terminal (PROVIDER_FAILED, retryable true)", async () => {
    const f = fixture({ ...TABLE, config: { treatUnclassifiedAsTransient: true } })
    f.p1.nextReject(new Error('one'))
    f.p2.nextReject(new Error('two'))
    const error = await expectCode(f.ai.run('echo', ARGS), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient', 'transient'])
  })
})

describe('the aborted row: caller-signal timing at the composition level', () => {
  it('abort during the primary attempt -> ABORTED, one attempt, the fallback never dispatched', async () => {
    const f = fixture(TABLE)
    const controller = new AbortController()
    f.p1.nextHang()
    const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
    await flushMicrotasks()
    controller.abort()
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = asSwitchError(run.error, 'ABORTED')
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['aborted'])
    expect(f.p2.requests.length).toBe(0)
    expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
  })

  it('abort during the fallback attempt -> ABORTED with the primary failure in the trail', async () => {
    const f = fixture(TABLE)
    const controller = new AbortController()
    f.p1.nextReject(new ProviderError('transient', { status: 503 }))
    f.p2.nextHang()
    const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
    await flushMicrotasks()
    expect(f.p2.requests.length).toBe(1)
    controller.abort()
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = asSwitchError(run.error, 'ABORTED')
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient', 'aborted'])
    expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
  })
})

describe('raw-unwrap rows: the user error by identity, settled first, no fallback', () => {
  function rawFixture(name: 'output_schema_error' | 'quality_error', bug: unknown): Fixture {
    if (name === 'quality_error') {
      return fixture({
        ...TABLE,
        quality: () => {
          throw bug
        },
      })
    }
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT.transform(() => {
          throw bug
        }),
        prompt: () => 'p',
        quota: QUOTA,
        defaultRoute: {
          provider: 'p1',
          model: 'm1',
          fallback: { provider: 'p2', model: 'm2' },
        },
      },
    } as unknown as OperationsMap
    return fixture({ operations })
  }

  for (const name of ['output_schema_error', 'quality_error'] as const) {
    it(`${name}: identity preserved, settlement observed before the throw, quota log intact`, async () => {
      const order: string[] = []
      const bug = new Error(`${name} bug`)
      const f = rawFixture(name, bug)
      f.s.settle.next(() => {
        order.push('settle')
        return undefined
      })
      const run = observe(
        f.ai.run('echo', ARGS).catch((error: unknown) => {
          order.push('thrown')
          throw error
        }),
      )
      await flushMicrotasks()
      expect(run.state).toBe('rejected')
      expect(run.error).toBe(bug)
      expect(order).toEqual(['settle', 'thrown'])
      expect(f.p2.requests.length).toBe(0)
      expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle failed'])
      expect(f.s.settle.calls[0]?.[2]?.map((a) => a.outcome)).toEqual([name])
    })
  }
})

describe('the prompt-stage rows stand alone: pre-quota, nothing dispatched', () => {
  it('a thrown prompt value passes through by identity before any quota call', async () => {
    const bug = new Error('prompt bug')
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => {
          throw bug
        },
        quota: QUOTA,
        defaultRoute: {
          provider: 'p1',
          model: 'm1',
          fallback: { provider: 'p2', model: 'm2' },
        },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    await expectSameRejection(f.ai.run('echo', ARGS), bug)
    expect(quotaLog(f)).toEqual([])
    expect(f.p1.requests.length).toBe(0)
    expect(f.p2.requests.length).toBe(0)
  })

  it('a non-string prompt return raises a core-created descriptive TypeError, nothing dispatched', async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 42,
        quota: QUOTA,
        defaultRoute: {
          provider: 'p1',
          model: 'm1',
          fallback: { provider: 'p2', model: 'm2' },
        },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    expect(run.error).toBeInstanceOf(TypeError)
    const message = (run.error as TypeError).message
    expect(message).toMatch(/must return a string/)
    expect(message).toContain('echo')
    expect(message).toContain('number')
    expect(quotaLog(f)).toEqual([])
    expect(f.p1.requests.length + f.p2.requests.length).toBe(0)
    expect(f.s.settle.calls.length).toBe(0)
  })
})

describe('the succeeded row', () => {
  it('primary success: data, route, usedFallback, attempts, aggregated usage, quota log', async () => {
    const f = fixture(TABLE)
    const result = await f.ai.run('echo', ARGS)
    expect(result.data).toEqual({ answer: 'ok' })
    expect(result.route).toEqual({ provider: 'p1', model: 'm1' })
    expect(result.usedFallback).toBe(false)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(result.usageComplete).toBe(true)
    expect(quotaLog(f)).toEqual(['reserve', 'commit', 'settle succeeded'])
  })
})
