/**
 * The quota lifecycle (spec §4): commit recovery with exact backoff, abort×recovery
 * interleavings, the hostile store-result matrix, settlement detachment and hook isolation
 *, the attempt-record snapshot, the changing-limit rules, and the §6a deadlines.
 */

import { describe, expect, it } from 'vitest'

import type { LLMDispatchError } from '../../../src/errors'
import { ProviderError } from '../../../src/errors'
import { createGlobalRuntime } from '../../../src/runtime'
import { createSwitchCore } from '../../../src/core/create-switch'
import { createMemoryStores } from '../../../src/stores/memory'
import type { OperationsMap, SettlementFailure } from '../../../src/types'
import type { Fixture } from './helpers'
import {
  expectCode,
  fixture,
  flushMicrotasks,
  grantFor,
  macrotask,
  observe,
  scriptedProvider,
  watchUnhandled,
  ECHO_INPUT,
  ECHO_OUTPUT,
  RESETS_AT,
  withThrowingGetter,
} from './helpers'

const INPUT = { input: { text: 'hi' } }
const ARGS = { ...INPUT, subjectId: 'u' }

function quotaFixture(config: Record<string, unknown> = {}) {
  return fixture({ quota: { perDay: 5 }, config })
}

describe('commit recovery', () => {
  it('re-reserves once on expired, commits the replacement, and settles against it', async () => {
    const f = quotaFixture()
    f.s.commit.nextResolve('expired')
    const result = await f.ai.run('echo', ARGS)
    expect(result.data).toEqual({ answer: 'ok' })
    const commits = f.s.commit.calls.map((call) => call[0])
    expect(commits.length).toBe(2)
    expect(commits[0]).not.toBe(commits[1]) // the replacement envelope's new id
    // Settlement carries the replacement envelope, not the expired one.
    const settled = f.s.settle.calls[0]![0] as { reservationId: string }
    expect(settled.reservationId).toBe(commits[1])
  })

  it('maps a second expired on the replacement commit to USAGE_STORE_UNAVAILABLE', async () => {
    const f = quotaFixture()
    f.s.commit.nextResolve('expired')
    f.s.commit.nextResolve('expired')
    await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
    expect(f.s.reserve.calls.length).toBe(2) // exactly one re-reserve, never a third
    expect(f.s.settle.calls.length).toBe(0)
  })

  it('maps missing on the replacement commit to USAGE_STORE_UNAVAILABLE', async () => {
    const f = quotaFixture()
    f.s.commit.nextResolve('expired')
    f.s.commit.nextResolve('missing')
    await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
  })

  it('retries a transport failure on the same id with the exact 250/500/1000 backoff', async () => {
    const f = quotaFixture()
    for (let i = 0; i < 4; i += 1) f.s.commit.nextReject(new Error(`transport ${String(i)}`))
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(f.s.commit.calls.length).toBe(1)
    expect(f.runtime.pendingDelays('referenced')).toEqual([250])
    await f.runtime.advance(250)
    expect(f.s.commit.calls.length).toBe(2)
    expect(f.runtime.pendingDelays('referenced')).toEqual([500])
    await f.runtime.advance(500)
    expect(f.s.commit.calls.length).toBe(3)
    expect(f.runtime.pendingDelays('referenced')).toEqual([1000])
    await f.runtime.advance(1000)
    expect(f.s.commit.calls.length).toBe(4)
    expect(run.state).toBe('rejected')
    expect((run.error as LLMDispatchError).code).toBe('USAGE_STORE_UNAVAILABLE')
    const ids = new Set(f.s.commit.calls.map((call) => call[0]))
    expect(ids.size).toBe(1) // always the same reservation id
    expect(f.s.settle.calls.length).toBe(0)
  })

  it('counts a commit deadline timeout as a transport failure and retries', async () => {
    const f = quotaFixture()
    const gate = f.s.commit.nextHang()
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(f.s.commit.calls.length).toBe(1)
    await f.runtime.advance(10_000) // the §6a commit deadline
    expect(run.state).toBe('pending')
    await f.runtime.advance(250) // then the first backoff
    expect(f.s.commit.calls.length).toBe(2) // retried on the same id …
    await flushMicrotasks()
    expect(run.state).toBe('resolved') // … and the healthy retry recovered the run
    expect(f.s.settle.calls.length).toBe(1)
    void gate // the first commit call is still pending, silently
  })
})

describe('abort × recovery interleavings', () => {
  it('never starts the next commit retry after an abort during the backoff window', async () => {
    const f = quotaFixture()
    const controller = new AbortController()
    f.s.commit.nextReject(new Error('transport'))
    const run = observe(f.ai.run('echo', ARGS, { signal: controller.signal }))
    await flushMicrotasks()
    expect(f.s.commit.calls.length).toBe(1)
    controller.abort() // inside the 250 ms backoff window
    await f.runtime.advance(1000)
    expect(run.state).toBe('rejected')
    expect((run.error as LLMDispatchError).code).toBe('ABORTED')
    expect(f.s.commit.calls.length).toBe(1) // the retry never started
    expect(f.s.settle.calls.length).toBe(0) // nothing was committed
    expect(f.s.log.filter((e) => e.startsWith('reserve')).length).toBe(1)
  })

  it('never re-reserves after an abort between expired and the re-reserve', async () => {
    const f = quotaFixture()
    const controller = new AbortController()
    f.s.commit.next(() => {
      controller.abort() // fires while the commit answer is in flight
      return 'expired'
    })
    const error = await expectCode(
      f.ai.run('echo', ARGS, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.attempts).toBeUndefined()
    expect(f.s.reserve.calls.length).toBe(1) // the re-reserve never started
    expect(f.s.settle.calls.length).toBe(0)
  })

  it('never starts the replacement commit after an abort following the re-reserve', async () => {
    const f = quotaFixture()
    const controller = new AbortController()
    f.s.commit.nextResolve('expired')
    f.s.reserve.next((key) => grantFor(key)) // consumed by the initial reserve
    f.s.reserve.next((key) => {
      controller.abort() // the replacement grant arrives, but the signal has fired
      return grantFor(key)
    })
    await expectCode(f.ai.run('echo', ARGS, { signal: controller.signal }), 'ABORTED')
    expect(f.s.reserve.calls.length).toBe(2)
    expect(f.s.commit.calls.length).toBe(1) // the replacement commit never started
    expect(f.s.settle.calls.length).toBe(0) // the replacement envelope expires on its own
  })
})

describe('hostile store results (fail-closed §4)', () => {
  const grants: {
    name: string
    grant: (key: { operation: string; subjectId: string }) => unknown
  }[] = [
    {
      name: 'a non-object reservation',
      grant: () => ({ ok: true, reservation: 42, expiresAt: RESETS_AT }),
    },
    {
      name: 'a non-string reservationId',
      grant: (key) => ({
        ok: true,
        reservation: { reservationId: 7, key, day: '2026-08-26' },
        expiresAt: RESETS_AT,
      }),
    },
    {
      name: 'a key that does not match',
      grant: (key) => ({
        ok: true,
        reservation: {
          reservationId: 'r',
          key: { ...key, subjectId: 'other' },
          day: '2026-08-26',
        },
        expiresAt: RESETS_AT,
      }),
    },
    {
      name: 'a day in the wrong format',
      grant: (key) => ({
        ok: true,
        reservation: { reservationId: 'r', key, day: '2026/08/26' },
        expiresAt: RESETS_AT,
      }),
    },
    {
      name: 'the year-zero day 0000-01-01 (a regex-only validator passes it)',
      grant: (key) => ({
        ok: true,
        reservation: { reservationId: 'r', key, day: '0000-01-01' },
        expiresAt: RESETS_AT,
      }),
    },
    {
      name: 'a day that does not exist on the calendar',
      grant: (key) => ({
        ok: true,
        reservation: { reservationId: 'r', key, day: '2026-02-30' },
        expiresAt: RESETS_AT,
      }),
    },
    {
      name: 'an unparseable expiresAt',
      grant: (key) => ({
        ok: true,
        reservation: { reservationId: 'r', key, day: '2026-08-26' },
        expiresAt: 'soon',
      }),
    },
  ]
  for (const { name, grant } of grants) {
    it(`refuses ${name} before any commit`, async () => {
      const f = quotaFixture()
      f.s.reserve.next((key) => grant(key))
      const error = await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
      expect(error.retryable).toBe(true)
      expect(f.s.commit.calls.length).toBe(0) // no dependent call
      expect(f.s.settle.calls.length).toBe(0)
    })
  }

  for (const day of ['0001-01-01', '9999-12-31']) {
    it(`accepts the boundary day ${day} end-to-end`, async () => {
      const f = quotaFixture()
      f.s.reserve.next((key) => ({
        ok: true,
        reservation: { reservationId: 'r-b', key, day },
        expiresAt: RESETS_AT,
      }))
      const result = await f.ai.run('echo', ARGS)
      expect(result.data).toEqual({ answer: 'ok' })
      expect((f.s.settle.calls[0]![0] as { day: string }).day).toBe(day)
    })
  }

  const denials: { name: string; denial: unknown }[] = [
    { name: 'a negative used', denial: { ok: false, used: -1, resetsAt: RESETS_AT } },
    {
      name: 'an unsafe-integer used',
      denial: { ok: false, used: 2 ** 53, resetsAt: RESETS_AT },
    },
    { name: 'a non-number used', denial: { ok: false, used: '5', resetsAt: RESETS_AT } },
    { name: 'an unparseable resetsAt', denial: { ok: false, used: 5, resetsAt: 'tomorrow' } },
    { name: 'a non-boolean ok', denial: { ok: 'no', used: 5, resetsAt: RESETS_AT } },
  ]
  for (const { name, denial } of denials) {
    it(`refuses a denial carrying ${name} as USAGE_STORE_UNAVAILABLE`, async () => {
      const f = quotaFixture()
      f.s.reserve.nextResolve(denial)
      const error = await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
      expect(error.code).toBe('USAGE_STORE_UNAVAILABLE') // not QUOTA_EXCEEDED
      expect(f.s.commit.calls.length).toBe(0)
    })
  }

  // A store answer whose own getters throw is malformed like any other: the throw is mapped,
  // never escaping the fail-closed guards raw, and it lands before the dependent store call.
  const throwers: {
    name: string
    script: (f: Fixture) => void
    dependent: (f: Fixture) => number
  }[] = [
    {
      name: 'a reserve answer whose ok getter throws',
      script: (f) => {
        f.s.reserve.nextResolve(withThrowingGetter({}, 'ok'))
      },
      dependent: (f) => f.s.commit.calls.length,
    },
    {
      name: 'a grant whose reservation getter throws',
      script: (f) => {
        f.s.reserve.nextResolve(withThrowingGetter({ ok: true }, 'reservation'))
      },
      dependent: (f) => f.s.commit.calls.length,
    },
    {
      name: 'a grant whose envelope day getter throws',
      script: (f) => {
        f.s.reserve.next((key) => ({
          ok: true,
          reservation: withThrowingGetter({ reservationId: 'r', key }, 'day'),
          expiresAt: RESETS_AT,
        }))
      },
      dependent: (f) => f.s.commit.calls.length,
    },
    {
      name: 'a denial whose resetsAt getter throws',
      script: (f) => {
        f.s.reserve.nextResolve(withThrowingGetter({ ok: false, used: 5 }, 'resetsAt'))
      },
      dependent: (f) => f.s.commit.calls.length,
    },
  ]
  for (const { name, script, dependent } of throwers) {
    it(`refuses ${name} before the dependent store call`, async () => {
      const f = quotaFixture()
      script(f)
      const error = await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
      expect(error.retryable).toBe(true)
      expect(dependent(f)).toBe(0)
    })
  }

  it('refuses an unknown commit string immediately, without transport retries', async () => {
    const f = quotaFixture()
    f.s.commit.nextResolve('acknowledged')
    await expectCode(f.ai.run('echo', ARGS), 'USAGE_STORE_UNAVAILABLE')
    expect(f.s.commit.calls.length).toBe(1) // fail-closed, never retried
    expect(f.runtime.pending()).toBe(0) // no backoff timer was ever scheduled
  })

  it('refuses a malformed snapshot through getQuota', async () => {
    for (const snapshot of [
      { used: -1, resetsAt: RESETS_AT },
      { used: 0.5, resetsAt: RESETS_AT },
      { used: 3, resetsAt: 'later' },
      withThrowingGetter({ used: 3 }, 'resetsAt'), // a throwing getter is malformed too
      null,
    ]) {
      const f = quotaFixture()
      f.s.snapshot.nextResolve(snapshot)
      await expectCode(f.ai.getQuota('echo', 'u'), 'USAGE_STORE_UNAVAILABLE')
    }
  })
})

describe('settlement detachment and retries', () => {
  it('settles the run before the 1 s retry timer ever advances, then retries independently', async () => {
    const f = quotaFixture()
    f.s.settle.nextReject(new Error('settle 1'))
    f.s.settle.nextReject(new Error('settle 2'))
    f.s.settle.nextReject(new Error('settle 3'))
    f.s.settle.nextReject(new Error('settle 4'))
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    // Ordering oracle: the run is settled and settle was called exactly once, and only the
    // detached 1 s retry timer is pending — in unreferenced mode, on the runtime seam.
    expect(run.state).toBe('resolved')
    expect(f.s.settle.calls.length).toBe(1)
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([1000])
    expect(f.runtime.pending('referenced')).toBe(0)
    await f.runtime.advance(1000)
    expect(f.s.settle.calls.length).toBe(2)
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([5000])
    await f.runtime.advance(5000)
    expect(f.s.settle.calls.length).toBe(3)
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([25_000])
    await f.runtime.advance(25_000)
    expect(f.s.settle.calls.length).toBe(4)
  })

  it('stops the chain at a recovered retry: no 5 s or 25 s attempt, no hook, no log', async () => {
    const hookCalls: unknown[] = []
    const loggerCalls: unknown[] = []
    const f = quotaFixture({
      onSettlementError: (error: unknown) => {
        hookCalls.push(error)
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (message: string) => {
          loggerCalls.push(message)
        },
      },
    })
    f.s.settle.nextReject(new Error('settle 1')) // only the initial attempt fails
    await f.ai.run('echo', ARGS)
    await f.runtime.advance(1000)
    expect(f.s.settle.calls.length).toBe(2) // the 1 s retry ran — and succeeded
    await f.runtime.advance(5000)
    await f.runtime.advance(25_000)
    expect(f.s.settle.calls.length).toBe(2) // a chain that keeps going fails here
    expect(f.runtime.pending()).toBe(0)
    expect(hookCalls).toEqual([])
    expect(loggerCalls).toEqual([])
  })

  it('gives each detached retry its own 10 s deadline, in unreferenced mode', async () => {
    const f = quotaFixture()
    f.s.settle.nextReject(new Error('settle 1'))
    const gate = f.s.settle.nextHang()
    await f.ai.run('echo', ARGS)
    await f.runtime.advance(1000) // the first retry starts and hangs
    expect(f.s.settle.calls.length).toBe(2)
    // Its per-attempt deadline is pending, and nothing referenced holds the process.
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([10_000])
    expect(f.runtime.pending('referenced')).toBe(0)
    await f.runtime.advance(10_000) // the deadline fires; the next retry is scheduled
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([5000])
    void gate
  })

  it('invokes the hook exactly once, after all four attempts failed, with the exact record — and logs once', async () => {
    const hookCalls: { error: unknown; record: SettlementFailure }[] = []
    const loggerCalls: { message: string; data: unknown }[] = []
    const finalError = new Error('settle 4')
    const f = quotaFixture({
      onSettlementError: (error: unknown, record: SettlementFailure) => {
        hookCalls.push({ error, record })
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (message: string, data?: unknown) => {
          loggerCalls.push({ message, data })
        },
      },
    })
    for (const error of ['settle 1', 'settle 2', 'settle 3'].map((m) => new Error(m))) {
      f.s.settle.nextReject(error)
    }
    f.s.settle.nextReject(finalError)
    await f.ai.run('echo', ARGS)
    await f.runtime.advance(1000)
    await f.runtime.advance(5000)
    expect(hookCalls.length).toBe(0) // a hook invoked before the fourth failure fails here
    await f.runtime.advance(25_000)
    await flushMicrotasks()
    expect(hookCalls.length).toBe(1)
    expect(hookCalls[0]!.error).toBe(finalError)
    const record = hookCalls[0]!.record
    expect(record.outcome).toBe('succeeded')
    expect(record.reservation.key).toEqual({ operation: 'echo', subjectId: 'u' })
    expect(record.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
    expect(loggerCalls.length).toBe(1)
    expect(loggerCalls[0]!.message).toContain('settlement failed')
    expect(loggerCalls[0]!.data).toBe(record)
    await f.runtime.advance(60_000) // nothing further: never re-logged in a loop
    expect(hookCalls.length).toBe(1)
    expect(loggerCalls.length).toBe(1)
  })

  it('surfaces nothing from a rejecting detached retry (terminal catch)', async () => {
    const watch = watchUnhandled()
    const f = quotaFixture()
    for (let i = 0; i < 4; i += 1) f.s.settle.nextReject(new Error('down'))
    await f.ai.run('echo', ARGS)
    await f.runtime.advance(31_000)
    await macrotask()
    await macrotask()
    expect(watch.seen).toEqual([])
    watch.stop()
  })

  it('keeps the settled payload immune to caller mutation of the returned attempts', async () => {
    const f = quotaFixture()
    f.s.settle.nextReject(new Error('settle 1'))
    const result = await f.ai.run('echo', ARGS)
    // The caller vandalizes everything it can reach, before the retry timer advances.
    result.attempts[0]!.outcome = 'refused'
    result.attempts[0]!.provider = 'vandal'
    result.attempts.push(result.attempts[0]!)
    await f.runtime.advance(1000)
    const retried = f.s.settle.calls[1]!
    expect(
      (retried[2] as { outcome: string; provider: string }[]).map((a) => a.outcome),
    ).toEqual(['succeeded'])
    expect(retried[2][0]!.provider).toBe('p1')
  })

  it('keeps a failed run’s settled payload immune to mutation of error.attempts', async () => {
    const f = fixture({ quota: { perDay: 5 }, fallback: false })
    f.p1.nextReject(new ProviderError('invalid_request'))
    f.s.settle.nextReject(new Error('settle 1'))
    const error = await expectCode(f.ai.run('echo', ARGS), 'PROVIDER_FAILED')
    error.attempts![0]!.outcome = 'succeeded'
    await f.runtime.advance(1000)
    const retried = f.s.settle.calls[1]!
    expect(retried[1]).toBe('failed')
    expect(retried[2][0]!.outcome).toBe('invalid_request')
  })
})

describe('settlement hook isolation', () => {
  type Poison = 'throws' | 'rejects' | 'never-resolves'
  const poisons: Poison[] = ['throws', 'rejects', 'never-resolves']

  function poisoned(kind: Poison): () => void | Promise<void> {
    if (kind === 'throws')
      return () => {
        throw new Error('hook bug')
      }
    if (kind === 'rejects') return () => Promise.reject(new Error('hook bug'))
    return () => new Promise<void>(() => undefined)
  }

  async function outcomeOf(
    config: Record<string, unknown>,
    which: 'success' | 'failure',
  ): Promise<Record<string, unknown>> {
    const f = fixture({ quota: { perDay: 5 }, fallback: false, config })
    if (which === 'failure')
      f.p1.nextReject(new ProviderError('invalid_request', { status: 413 }))
    for (let i = 0; i < 4; i += 1) f.s.settle.nextReject(new Error('settle down'))
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(run.state).not.toBe('pending') // the run never hangs on the hook
    await f.runtime.advance(31_000) // drive the whole detached tail, hook included
    await flushMicrotasks()
    if (which === 'success') {
      expect(run.state).toBe('resolved')
      return { value: JSON.parse(JSON.stringify(run.value)) as unknown }
    }
    expect(run.state).toBe('rejected')
    const error = run.error as LLMDispatchError
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      attempts: JSON.parse(JSON.stringify(error.attempts)) as unknown,
    }
  }

  for (const which of ['success', 'failure'] as const) {
    for (const poison of poisons) {
      it(`keeps a ${which} outcome byte-identical under a hook that ${poison}`, async () => {
        const control = await outcomeOf({}, which)
        const poisonedOutcome = await outcomeOf({ onSettlementError: poisoned(poison) }, which)
        expect(poisonedOutcome).toEqual(control)
      })

      it(`keeps a ${which} outcome byte-identical under a logger that ${poison}`, async () => {
        const control = await outcomeOf({}, which)
        const logger = {
          info: poisoned(poison),
          warn: poisoned(poison),
          error: poisoned(poison),
        }
        const poisonedOutcome = await outcomeOf({ logger }, which)
        expect(poisonedOutcome).toEqual(control)
      })
    }
  }
})

describe('the root runtime adapter', () => {
  it('calls .unref() exactly when unreferenced mode is requested, and never otherwise', () => {
    const scheduled: { callback: unknown; handle: { unref: () => void; unrefs: number } }[] = []
    const cleared: unknown[] = []
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    try {
      ;(globalThis as { setTimeout: unknown }).setTimeout = (callback: unknown) => {
        const handle = {
          unrefs: 0,
          unref(): void {
            handle.unrefs += 1
          },
        }
        scheduled.push({ callback, handle })
        return handle
      }
      ;(globalThis as { clearTimeout: unknown }).clearTimeout = (handle: unknown) => {
        cleared.push(handle)
      }
      const runtime = createGlobalRuntime()
      const referenced = runtime.schedule(() => undefined, 100, 'referenced')
      const unreferenced = runtime.schedule(() => undefined, 100, 'unreferenced')
      expect(scheduled[0]!.handle.unrefs).toBe(0) // a mode-ignoring adapter fails here …
      expect(scheduled[1]!.handle.unrefs).toBe(1) // … and a mode-inverting one here
      runtime.cancel(referenced)
      runtime.cancel(unreferenced)
      expect(cleared).toEqual([scheduled[0]!.handle, scheduled[1]!.handle])
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('works over hosts whose timer handles have no unref', () => {
    const originalSetTimeout = globalThis.setTimeout
    try {
      ;(globalThis as { setTimeout: unknown }).setTimeout = () => 42 // a browser-style id
      const runtime = createGlobalRuntime()
      expect(() => runtime.schedule(() => undefined, 100, 'unreferenced')).not.toThrow()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})

describe('changing a limit while runs are in flight (§4 rules 1–5)', () => {
  it('rule 1: a run completes recovery against its captured limit, despite a mid-run change', async () => {
    const f = quotaFixture()
    const gate = f.s.commit.nextHang()
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    await f.ai.setConfig('echo', { provider: 'p1', model: 'm1', quota: { perDay: 1 } })
    gate.resolve('expired') // recovery begins only after the limit changed
    await flushMicrotasks()
    expect(run.state).toBe('resolved')
    // The re-reserve used the limit captured at stage 4, not the new one.
    expect(f.s.reserve.calls.map((call) => call[1])).toEqual([5, 5])
  })

  it('rule 4 (in flight): removing the ONLY quota mid-run — the pending envelope finishes, new runs are quota-less', async () => {
    // The definition declares no quota: the only quota is the stored route's, so removing
    // it removes quota governance entirely (§4 rule 4).
    const f = fixture() // no declared quota
    let row: Record<string, unknown> = { provider: 'p1', model: 'm1', quota: { perDay: 5 } }
    f.s.getAll.always(() => ({ echo: { ...row } }))
    const gate = f.s.commit.nextHang()
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(f.s.reserve.calls.map((call) => call[1])).toEqual([5]) // governed by the route quota
    // While the reservation is pending: clear the quota from the stored row.
    await f.ai.setConfig('echo', { provider: 'p1', model: 'm1' })
    row = { provider: 'p1', model: 'm1' }
    gate.resolve('committed')
    await flushMicrotasks()
    // The in-flight run's captured limit still governed it through commit and settlement.
    expect(run.state).toBe('resolved')
    expect(f.s.settle.calls.length).toBe(1)
    // A new, cache-visible run is non-quota: no reserve at all, and getQuota refuses.
    await f.ai.run('echo', ARGS)
    expect(f.s.reserve.calls.length).toBe(1)
    expect(f.s.settle.calls.length).toBe(1) // nothing further to settle either
    await expectCode(f.ai.getQuota('echo', 'u'), 'INVALID_INPUT')
  })

  it('rules 2, 3 and 4, end-to-end on the in-memory store', async () => {
    const runtime = createGlobalRuntime()
    const memory = createMemoryStores({})
    const p1 = scriptedProvider()
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1', quota: { perDay: 2 } },
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers: { p1: p1.provider },
        operations,
        stores: memory.stores,
        configTtlMs: 0, // every change is cache-visible immediately (rule 5 boundary)
      },
      runtime,
    )
    await ai.run('echo', ARGS)
    await ai.run('echo', ARGS) // two committed slots
    // Rule 2: lowered to at or below used — here to 0 — denies new reservations …
    await ai.setConfig('echo', { provider: 'p1', model: 'm1', quota: { perDay: 0 } })
    const denied = await expectCode(ai.run('echo', ARGS), 'QUOTA_EXCEEDED')
    expect(denied.resetsAt).toBeDefined()
    expect(Number.isNaN(Date.parse(denied.resetsAt ?? ''))).toBe(false)
    // … while every already-committed slot stands:
    const view = await ai.getQuota('echo', 'u')
    expect(view.used).toBe(2)
    // Rule 3: used > limit reports remaining 0.
    expect(view.limit).toBe(0)
    expect(view.remaining).toBe(0)
    // Rule 4: removing the only quota makes new runs non-quota and getQuota INVALID_INPUT.
    await ai.setConfig('echo', { provider: 'p1', model: 'm1' })
    const result = await ai.run('echo', ARGS) // a third run, despite used=2: no quota governs
    expect(result.data).toEqual({ answer: 'ok' })
    await expectCode(ai.getQuota('echo', 'u'), 'INVALID_INPUT')
    // The two settled slots' rows were untouched throughout.
    const inspection = await memory.controls.inspect(
      { operation: 'echo', subjectId: 'u' },
      todayUtc(),
    )
    expect(inspection.counter?.used).toBe(2)
  })
})

describe('§6a deadlines on the usage store', () => {
  it('bounds reserve at 10 s from the call', async () => {
    const f = quotaFixture()
    const gate = f.s.reserve.nextHang()
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    await f.runtime.advance(9999)
    expect(run.state).toBe('pending')
    await f.runtime.advance(1)
    expect(run.state).toBe('rejected')
    expect((run.error as LLMDispatchError).code).toBe('USAGE_STORE_UNAVAILABLE')
    void gate
  })

  it('bounds the initial settle at 10 s and moves on to the detached tail', async () => {
    const f = quotaFixture()
    const gate = f.s.settle.nextHang()
    const run = observe(f.ai.run('echo', ARGS))
    await flushMicrotasks()
    expect(run.state).toBe('pending') // the initial settle is awaited …
    await f.runtime.advance(10_000)
    expect(run.state).toBe('resolved') // … to its deadline, and never longer
    expect(f.runtime.pendingDelays('unreferenced')).toEqual([1000])
    void gate
  })
})

/** Today's UTC day, matching what the real-clock memory store files rows under. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
