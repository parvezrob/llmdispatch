/**
 * P2 — the abort rule: cancellation while each raced seam is pending, rigorous suppression
 * of the loser's late rejection, the in-flight reserve/commit exception, re-classification
 * of adapter-reported aborts, the composed signal's two independent sources, non-cooperative
 * providers, and cleanup (timers and listeners) after every completion.
 */

import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { LLMSwitchError } from '../../../src/errors'
import { ProviderError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import type { OperationsMap } from '../../../src/types'
import {
  deferred,
  expectCode,
  expectSameRejection,
  fakeRuntime,
  fixture,
  flushMicrotasks,
  macrotask,
  observe,
  okResponse,
  scriptedStores,
  watchUnhandled,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT = { input: { text: 'hi' } }

/** A fixture whose named seam waits on the returned gate. */
function seamFixture(seam: 'input' | 'prepare' | 'prompt' | 'output' | 'quality') {
  const runtime = fakeRuntime()
  const s = scriptedStores()
  const gate = deferred<never>()
  let seamEntered = false
  const enter = <T>(value: Promise<T>): Promise<T> => {
    seamEntered = true
    return value
  }
  const schema = (real: unknown, gated: boolean) =>
    gated ? { parseAsync: () => enter(gate.promise) } : real
  const operations = {
    echo: {
      input: schema(ECHO_INPUT, seam === 'input'),
      output: schema(ECHO_OUTPUT, seam === 'output'),
      prompt: seam === 'prompt' ? () => enter(gate.promise) : () => 'p',
      quality: seam === 'quality' ? () => enter(gate.promise) : undefined,
      defaultRoute: { provider: 'p1', model: 'm1' },
    },
  } as unknown as OperationsMap
  const provider = {
    prepare:
      seam === 'prepare'
        ? () => enter(gate.promise)
        : () => ({ complete: () => Promise.resolve(okResponse()) }),
    complete: () => Promise.resolve(okResponse()),
  }
  const ai = createSwitchCore(
    {
      providers: { p1: provider },
      operations,
      stores: s.stores,
    },
    runtime,
  )
  return { ai, s, gate, runtime, seamEntered: () => seamEntered }
}

describe('cancellation while each raced seam is pending', () => {
  for (const seam of ['input', 'prepare', 'prompt', 'output', 'quality'] as const) {
    it(`ends ABORTED promptly while ${seam} is pending, and suppresses its late rejection`, async () => {
      const watch = watchUnhandled()
      const { ai, gate, runtime, seamEntered } = seamFixture(seam)
      const controller = new AbortController()
      const run = observe(ai.run('echo', INPUT, { signal: controller.signal }))
      await flushMicrotasks()
      expect(seamEntered()).toBe(true)
      expect(run.state).toBe('pending')
      controller.abort()
      await flushMicrotasks()
      expect(run.state).toBe('rejected') // the seam is still open; the core stopped waiting
      expect((run.error as LLMSwitchError).code).toBe('ABORTED')
      // The loser provably rejects only after the run has ended, and stays silent.
      gate.reject(new Error(`late ${seam} failure`))
      await macrotask()
      await macrotask()
      expect(watch.seen).toEqual([])
      watch.stop()
      // Cleanup: nothing referenced still pending, and the caller's signal is released.
      expect(runtime.pending('referenced')).toBe(0)
      expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    })
  }
})

describe('abort at stage boundaries', () => {
  it('is caught at the boundary after config resolution, before dispatch', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    f.s.getAll.next(() => {
      controller.abort()
      return {}
    })
    const error = await expectCode(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.attempts).toBeUndefined()
    expect(f.p1.requests.length).toBe(0)
    expect(f.s.log).toEqual(['getAll']) // no reserve after the boundary catch
  })

  it('awaits an in-flight reserve to its result, then ends ABORTED without commit', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    const gate = s.reserve.nextHang()
    const run = observe(
      ai.run('echo', { ...INPUT, subjectId: 'u' }, { signal: controller.signal }),
    )
    await flushMicrotasks()
    expect(s.log).toEqual(['getAll', 'reserve u 5'])
    controller.abort()
    await flushMicrotasks()
    expect(run.state).toBe('pending') // reserve has side effects: it is awaited, not raced
    gate.resolve({
      ok: true,
      reservation: {
        reservationId: 'r-9',
        key: { operation: 'echo', subjectId: 'u' },
        day: '2026-08-26',
      },
      expiresAt: '2026-08-26T00:02:00.000Z',
    })
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    expect((run.error as LLMSwitchError).code).toBe('ABORTED')
    expect((run.error as LLMSwitchError).attempts).toBeUndefined()
    // Pre-commit: the pending envelope stands and expires on its own; nothing was settled.
    expect(s.log).toEqual(['getAll', 'reserve u 5'])
  })

  it('awaits an in-flight commit, then ends ABORTED undispatched — and still settles', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    const gate = f.s.commit.nextHang()
    const run = observe(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }, { signal: controller.signal }),
    )
    await flushMicrotasks()
    expect(f.s.log.filter((e) => e.startsWith('commit')).length).toBe(1)
    controller.abort()
    await flushMicrotasks()
    expect(run.state).toBe('pending')
    gate.resolve('committed')
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    expect((run.error as LLMSwitchError).code).toBe('ABORTED')
    // Committed counts: the post-commit path settles, failed, with no attempts.
    expect(f.p1.requests.length).toBe(0)
    expect(f.s.settle.calls.length).toBe(1)
    expect(f.s.settle.calls[0]![1]).toBe('failed')
    expect(f.s.settle.calls[0]![2]).toEqual([])
  })
})

describe('suppression companions — what must NOT be suppressed', () => {
  it('propagates a seam rejection raw when no abort happened', async () => {
    const bug = new Error('prompt exploded')
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => Promise.reject(bug),
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const { ai } = fixture({ operations })
    await expectSameRejection(ai.run('echo', INPUT), bug)
  })

  it('classifies a pre-deadline store rejection normally', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.reserve.nextReject(new Error('store down'))
    const error = await expectCode(
      ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'USAGE_STORE_UNAVAILABLE',
    )
    expect(error.retryable).toBe(true)
  })

  it('never suppresses a settlement rejection — it drives the retry tail', async () => {
    const { ai, s, runtime } = fixture({ quota: { perDay: 5 } })
    s.settle.nextReject(new Error('settle down'))
    await ai.run('echo', { ...INPUT, subjectId: 'u' })
    // The failure was consumed by the retry machinery: the 1 s retry timer is pending.
    expect(runtime.pendingDelays('unreferenced')).toEqual([1000])
  })
})

describe('adapter-reported aborts and the composed signal', () => {
  it("maps an adapter 'aborted' to ABORTED when the caller's signal fired", async () => {
    const f = fixture()
    const controller = new AbortController()
    f.p1.next((request) => {
      // A cooperative adapter: observes the composed signal and throws 'aborted'.
      controller.abort()
      expect(request.signal.aborted).toBe(true)
      throw new ProviderError('aborted')
    })
    const error = await expectCode(
      f.ai.run('echo', INPUT, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['aborted'])
  })

  it("re-classifies an adapter 'aborted' as timeout when the caller's signal did not fire", async () => {
    const f = fixture()
    f.p1.nextReject(new ProviderError('aborted'))
    const result = await f.ai.run('echo', INPUT)
    // timeout is fallback-eligible, so the run was rescued by the fallback.
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['timeout', 'succeeded'])
  })

  it('aborts the provider-observed signal on caller abort alone, and ends ABORTED with the attempt recorded', async () => {
    const f = fixture()
    const controller = new AbortController()
    const hang = f.p1.nextHang()
    const run = observe(f.ai.run('echo', INPUT, { signal: controller.signal }))
    await flushMicrotasks()
    const request = f.p1.requests[0]!
    expect(request.signal.aborted).toBe(false)
    controller.abort()
    await flushMicrotasks()
    // The provider promise is still pending; the core classified from its own flags.
    expect(request.signal.aborted).toBe(true)
    expect(run.state).toBe('rejected')
    const error = run.error as LLMSwitchError
    expect(error.code).toBe('ABORTED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['aborted'])
    expect(f.runtime.pending('referenced')).toBe(0) // the timeout timer was cancelled
    void hang // never settled — deliberately
  })

  it('aborts the provider-observed signal on timeoutMs alone, with the caller quiescent', async () => {
    const f = fixture({ timeoutMs: 2000, fallback: false })
    const controller = new AbortController()
    const hang = f.p1.nextHang() // non-cooperative: never settles
    const run = observe(f.ai.run('echo', INPUT, { signal: controller.signal }))
    await flushMicrotasks()
    const request = f.p1.requests[0]!
    await f.runtime.advance(2000)
    expect(request.signal.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false) // this source alone fired
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = run.error as LLMSwitchError
    expect(error.code).toBe('PROVIDER_FAILED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['timeout'])
    void hang
  })

  it('classifies timeout on a non-cooperative provider and lets the fallback rescue', async () => {
    const f = fixture({ timeoutMs: 2000 })
    const hang = f.p1.nextHang() // ignores its signal, never settles
    const run = observe(f.ai.run('echo', INPUT))
    await f.runtime.advance(2000)
    await flushMicrotasks()
    expect(run.state).toBe('resolved')
    expect(run.value?.usedFallback).toBe(true)
    expect(run.value?.attempts.map((a) => a.outcome)).toEqual(['timeout', 'succeeded'])
    void hang
  })

  it('classifies timeout as the terminal code without a fallback', async () => {
    const f = fixture({ timeoutMs: 2000, fallback: false })
    const hang = f.p1.nextHang()
    const run = observe(f.ai.run('echo', INPUT))
    await f.runtime.advance(2000)
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    const error = run.error as LLMSwitchError
    expect(error.code).toBe('PROVIDER_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['timeout'])
    void hang
  })
})

describe('abort after a successful attempt', () => {
  it('returns the result and settles succeeded even when the signal fires during settlement', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    const gate = f.s.settle.nextHang()
    const run = observe(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }, { signal: controller.signal }),
    )
    await flushMicrotasks()
    expect(f.s.settle.calls.length).toBe(1)
    controller.abort() // during finalization: must not cancel the awaited initial settle
    await flushMicrotasks()
    expect(run.state).toBe('pending')
    gate.resolve(undefined)
    await flushMicrotasks()
    expect(run.state).toBe('resolved')
    expect(run.value?.data).toEqual({ answer: 'ok' })
    expect(f.s.settle.calls[0]![1]).toBe('succeeded')
  })
})

describe('cleanup', () => {
  it('leaves no pending referenced timers and no listeners after a plain success', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    const controller = new AbortController()
    const result = await f.ai.run(
      'echo',
      { ...INPUT, subjectId: 'u' },
      { signal: controller.signal },
    )
    expect(result.data).toEqual({ answer: 'ok' })
    expect(f.runtime.pending('referenced')).toBe(0)
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  })

  it('leaves no pending referenced timers and no listeners after a terminal failure', async () => {
    const f = fixture({ quota: { perDay: 5 }, fallback: false })
    const controller = new AbortController()
    f.p1.nextReject(new ProviderError('invalid_request'))
    await expectCode(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }, { signal: controller.signal }),
      'PROVIDER_FAILED',
    )
    expect(f.runtime.pending('referenced')).toBe(0)
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  })

  it('does not bound output parsing or quality by timeoutMs', async () => {
    const gate = deferred<{ answer: string }>()
    let outputCalls = 0
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: {
          parseAsync: () => {
            outputCalls += 1
            return gate.promise
          },
        },
        prompt: () => 'p',
        timeoutMs: 2000,
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    const run = observe(f.ai.run('echo', INPUT))
    await flushMicrotasks()
    expect(outputCalls).toBe(1)
    await f.runtime.advance(10_000) // far past timeoutMs, while parsing is pending
    expect(run.state).toBe('pending')
    expect(f.p1.requests[0]!.signal.aborted).toBe(false) // the attempt timer was cancelled
    gate.resolve({ answer: 'slow' })
    await flushMicrotasks()
    expect(run.state).toBe('resolved')
    expect(run.value?.data).toEqual({ answer: 'slow' })
  })
})
