/**
 * P11 — the state-machine property test (standards §4): over arbitrary sequences of
 * provider outcomes, store outcomes and signal timings — never two reservations per run
 * beyond the single §4 re-reserve, never a lost settle on a post-commit path, `retryable`
 * always the literal, cleanup invariants as postconditions, and the terminal-code
 * invariant conditioned on attempt-determined termination.
 */

import { getEventListeners } from 'node:events'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { LLMSwitchError, ProviderError } from '../../../src/errors'
import type { ProviderResponse } from '../../../src/types'
import { fixture, flushMicrotasks, grantFor, observe } from './helpers'

const ARGS = { input: { text: 'hi' }, subjectId: 'u' }

/** What one attempt's provider is scripted to do. */
type AttemptScript =
  | 'success'
  | 'bad-json'
  | 'truncated'
  | 'refused'
  | 'transient'
  | 'rate_limit'
  | 'auth'
  | 'invalid_request'
  | 'unclassified'

/** The §5b terminal columns, keyed by a recorded attempt outcome. */
const OUTCOME_MEANING: Record<string, { code: LLMSwitchError['code']; retryable: boolean }> = {
  output_rejected: { code: 'OUTPUT_REJECTED', retryable: true },
  truncated: { code: 'OUTPUT_REJECTED', retryable: true },
  refused: { code: 'PROVIDER_FAILED', retryable: false },
  transient: { code: 'PROVIDER_FAILED', retryable: true },
  rate_limit: { code: 'PROVIDER_FAILED', retryable: true },
  malformed_response: { code: 'PROVIDER_FAILED', retryable: true },
  timeout: { code: 'PROVIDER_FAILED', retryable: true },
  auth: { code: 'INVALID_CONFIG', retryable: false },
  model_not_found: { code: 'INVALID_CONFIG', retryable: false },
  invalid_request: { code: 'PROVIDER_FAILED', retryable: false },
  provider_unclassified: { code: 'PROVIDER_FAILED', retryable: false },
}

interface Scenario {
  reserve: 'grant' | 'deny' | 'reject'
  commits: ('committed' | 'expired' | 'missing' | 'reject')[]
  primary: AttemptScript
  fallback: AttemptScript
  settleFails: boolean
  abortAt: 'never' | 'reserve' | 'commit' | 'primary' | 'fallback'
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  reserve: fc.constantFrom('grant', 'deny', 'reject'),
  commits: fc.array(fc.constantFrom('committed', 'expired', 'missing', 'reject'), {
    minLength: 1,
    maxLength: 3,
  }),
  primary: fc.constantFrom(
    'success',
    'bad-json',
    'truncated',
    'refused',
    'transient',
    'rate_limit',
    'auth',
    'invalid_request',
    'unclassified',
  ),
  fallback: fc.constantFrom(
    'success',
    'bad-json',
    'refused',
    'transient',
    'auth',
    'invalid_request',
  ),
  settleFails: fc.boolean(),
  abortAt: fc.constantFrom('never', 'reserve', 'commit', 'primary', 'fallback'),
})

function scriptAttempt(script: AttemptScript): () => ProviderResponse {
  return () => {
    switch (script) {
      case 'success':
        return {
          kind: 'complete',
          text: '{"answer":"ok"}',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      case 'bad-json':
        return {
          kind: 'complete',
          text: 'not json',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      case 'truncated':
        return { kind: 'truncated', text: '', usage: { inputTokens: 1, outputTokens: 1 } }
      case 'refused':
        return { kind: 'refused', text: '', usage: null }
      case 'transient':
        throw new ProviderError('transient', { status: 503 })
      case 'rate_limit':
        throw new ProviderError('rate_limit', { status: 429 })
      case 'auth':
        throw new ProviderError('auth', { status: 401 })
      case 'invalid_request':
        throw new ProviderError('invalid_request', { status: 413 })
      case 'unclassified':
        throw new Error('custom failure')
    }
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  const f = fixture({ quota: { perDay: 5 } })
  const controller = new AbortController()

  // Stores.
  if (scenario.reserve === 'deny') {
    f.s.reserve.always(() => ({ ok: false, used: 5, resetsAt: '2026-08-27T00:00:00.000Z' }))
  } else if (scenario.reserve === 'reject') {
    f.s.reserve.always(() => {
      throw new Error('reserve down')
    })
  } else {
    f.s.reserve.always((key) => {
      if (scenario.abortAt === 'reserve') controller.abort()
      return grantFor(key)
    })
  }
  let commitIndex = 0
  f.s.commit.always(() => {
    const step =
      scenario.commits[Math.min(commitIndex, scenario.commits.length - 1)] ?? 'committed'
    commitIndex += 1
    if (scenario.abortAt === 'commit') controller.abort()
    if (step === 'reject') throw new Error('commit down')
    return step
  })
  if (scenario.settleFails) {
    f.s.settle.always(() => {
      throw new Error('settle down')
    })
  }

  // Providers.
  f.p1.always((request) => {
    void request
    if (scenario.abortAt === 'primary') controller.abort()
    return scriptAttempt(scenario.primary)()
  })
  f.p2.always(() => {
    if (scenario.abortAt === 'fallback') controller.abort()
    return scriptAttempt(scenario.fallback)()
  })

  const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
  await flushMicrotasks()
  await f.runtime.advance(60_000) // burn every backoff and every detached retry deadline
  await f.runtime.advance(60_000)
  await flushMicrotasks()

  // The run always settles.
  expect(run.state).not.toBe('pending')

  // Never more than two reservations: the original plus §4's single re-reserve.
  expect(f.s.reserve.calls.length).toBeLessThanOrEqual(2)

  // Never a lost settle on a post-commit path — and never a settle without a commit.
  const committed = f.s.commit.calls.length > 0 && sawValidatedCommit(scenario)
  const initialSettles = f.s.settle.calls.length > 0
  if (committed) {
    expect(initialSettles).toBe(true)
  } else {
    expect(f.s.settle.calls.length).toBe(0)
  }

  // Cleanup postconditions.
  expect(f.runtime.pending('referenced')).toBe(0)
  expect(getEventListeners(controller.signal, 'abort').length).toBe(0)

  if (run.state === 'resolved') return
  const error = run.error as LLMSwitchError
  expect(error).toBeInstanceOf(LLMSwitchError)

  // `retryable` is always the literal of the code/classification tables.
  const attemptDetermined = error.attempts !== undefined && error.code !== 'ABORTED'
  switch (error.code) {
    case 'USAGE_STORE_UNAVAILABLE':
    case 'CONFIG_STORE_UNAVAILABLE':
      expect(error.retryable).toBe(true)
      break
    case 'QUOTA_EXCEEDED':
    case 'ABORTED':
    case 'INVALID_INPUT':
    case 'MISSING_SUBJECT':
      expect(error.retryable).toBe(false)
      break
    case 'INVALID_CONFIG':
    case 'PROVIDER_FAILED':
    case 'OUTPUT_REJECTED': {
      const meaning = OUTCOME_MEANING[error.attempts?.at(-1)?.outcome ?? '']
      if (attemptDetermined && meaning !== undefined) {
        expect(error.retryable).toBe(meaning.retryable)
      }
      break
    }
  }

  // Terminal-code invariant, conditioned on attempt-determined termination: for a run the
  // signal did not end, the terminal code is the final attempt's §5b row.
  const finalOutcome = error.attempts?.at(-1)?.outcome
  if (attemptDetermined && finalOutcome !== undefined) {
    const meaning = OUTCOME_MEANING[finalOutcome]
    if (meaning !== undefined) expect(error.code).toBe(meaning.code)
  }
}

/** Whether the scripted commit sequence reaches a validated 'committed'. */
function sawValidatedCommit(scenario: Scenario): boolean {
  if (scenario.reserve !== 'grant') return false
  if (scenario.abortAt === 'reserve') return false
  const step = (index: number): string =>
    scenario.commits[Math.min(index, scenario.commits.length - 1)] ?? 'committed'
  let index = 0
  // One commit call with its §4 transport-retry arm, consuming the script like the core.
  const walk = (): string => {
    for (let tries = 0; tries < 4; tries += 1) {
      const answer = step(index)
      index += 1
      if (answer === 'reject') {
        // A transport failure retries — unless the abort fired inside the commit handler,
        // in which case the pre-retry signal check ends the run first.
        if (scenario.abortAt === 'commit') return 'aborted'
        continue
      }
      return answer
    }
    return 'exhausted'
  }
  const first = walk()
  if (first === 'committed') return true
  if (first !== 'expired') return false
  if (scenario.abortAt === 'commit') return false // checked before the re-reserve I/O
  const second = walk()
  return second === 'committed'
}

describe('the run state machine, property-tested', () => {
  it('holds its invariants over arbitrary outcome sequences and signal timings', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await runScenario(scenario)
      }),
      { numRuns: 120 },
    )
  }, 120_000)

  it('example: abort at the stage-10 boundary after a transient primary ends ABORTED, settled failed', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    f.p1.next(() => {
      // The abort lands a few microtasks after the classified rejection — exactly at the
      // stage-10 boundary, after the transient attempt was recorded and before the
      // fallback decision. (One tick earlier it would race the dispatch itself.)
      void Promise.resolve()
        .then(() => undefined)
        .then(() => undefined)
        .then(() => {
          controller.abort()
        })
      throw new ProviderError('transient', { status: 503 })
    })
    const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = run.error as LLMSwitchError
    expect(error.code).toBe('ABORTED') // the abort rule wins over the fallback decision
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient'])
    expect(f.p2.requests.length).toBe(0) // the fallback never dispatched
    expect(f.s.settle.calls.length).toBe(1)
    expect(f.s.settle.calls[0]![1]).toBe('failed')
  })

  it('example: abort at the finalization boundary after the final attempt failed ends ABORTED with attempts', async () => {
    const f = fixture({ quota: { perDay: 5 }, fallback: false })
    const controller = new AbortController()
    f.p1.next(() => {
      void Promise.resolve()
        .then(() => undefined)
        .then(() => undefined)
        .then(() => {
          controller.abort() // after the final attempt's classification, at the boundary
        })
      throw new ProviderError('invalid_request', { status: 413 })
    })
    const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = run.error as LLMSwitchError
    expect(error.code).toBe('ABORTED') // only abort after a successful attempt is outcome-immune
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['invalid_request'])
    expect(f.s.settle.calls[0]![1]).toBe('failed')
  })
})
