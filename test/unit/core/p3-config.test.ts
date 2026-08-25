/**
 * P3 — config resolution (spec §2): the resolution matrix, TTL semantics, the
 * generation-coherence matrix with call counts, the observable mutex oracle, the numeric
 * validation matrix, the admin method matrix, strict route validation at all three seats,
 * and the effective-quota precedence oracle.
 */

import { describe, expect, it } from 'vitest'

import { LLMSwitchError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import type { CreateSwitchConfig, OperationsMap } from '../../../src/types'
import {
  expectCode,
  fakeRuntime,
  fixture,
  flushMicrotasks,
  observe,
  okResponse,
  scriptedProvider,
  scriptedStores,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT = { input: { text: 'hi' } }

/** Two operations on one switch, for isolation and mutex-independence cases. */
function twoOps() {
  const runtime = fakeRuntime()
  const s = scriptedStores()
  const p1 = scriptedProvider()
  const operations = {
    alpha: {
      input: ECHO_INPUT,
      output: ECHO_OUTPUT,
      prompt: () => 'p',
      defaultRoute: { provider: 'p1', model: 'alpha-default' },
    },
    beta: {
      input: ECHO_INPUT,
      output: ECHO_OUTPUT,
      prompt: () => 'p',
      defaultRoute: { provider: 'p1', model: 'beta-default' },
    },
  } as unknown as OperationsMap
  const ai = createSwitchCore(
    {
      providers: { p1: p1.provider },
      operations,
      stores: s.stores,
    },
    runtime,
  )
  return { ai, s, p1, runtime }
}

function getAllCount(s: ReturnType<typeof scriptedStores>): number {
  return s.log.filter((entry) => entry === 'getAll').length
}

describe('the §2 resolution matrix and the cache', () => {
  it('serves a fresh cache without a store read', async () => {
    const { ai, s } = fixture()
    await ai.run('echo', INPUT)
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(1) // second run inside the default 5 s TTL
  })

  it('reads every run when configTtlMs is 0', async () => {
    const { ai, s } = fixture({ config: { configTtlMs: 0 } })
    await ai.run('echo', INPUT)
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(2)
  })

  it('re-reads once the entry is stale', async () => {
    const { ai, s, runtime } = fixture()
    await ai.run('echo', INPUT)
    await runtime.advance(5001)
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(2)
  })

  it('uses a valid stored row as the effective route and caches it', async () => {
    const { ai, s, p1 } = fixture()
    s.getAll.always(() => ({ echo: { provider: 'p1', model: 'stored-model' } }))
    await ai.run('echo', INPUT)
    await ai.run('echo', INPUT)
    expect(p1.requests.map((r) => r.model)).toEqual(['stored-model', 'stored-model'])
    expect(getAllCount(s)).toBe(1)
  })

  it('isolates a malformed row to its operation and never caches it', async () => {
    const { ai, s, p1 } = twoOps()
    s.getAll.always(() => ({ alpha: { provider: 'p1' } })) // malformed: no model
    await expectCode(ai.run('alpha', INPUT), 'INVALID_CONFIG')
    await ai.run('beta', INPUT) // the sibling operation is unaffected
    expect(p1.requests.map((r) => r.model)).toEqual(['beta-default'])
    await expectCode(ai.run('alpha', INPUT), 'INVALID_CONFIG')
    // alpha re-read on every attempt (not cached); beta had its own read, then its cache.
    expect(getAllCount(s)).toBe(3)
  })

  it('negative-caches the defaultRoute when there is no row', async () => {
    const { ai, s, p1 } = fixture()
    await ai.run('echo', INPUT)
    await ai.run('echo', INPUT)
    expect(p1.requests.map((r) => r.model)).toEqual(['m1', 'm1'])
    expect(getAllCount(s)).toBe(1) // the absence itself was cached as the default
  })

  it('fails closed on a non-record container instead of reading it as "no rows"', async () => {
    for (const container of [null, [], 42, 'rows']) {
      const { ai } = fixture()
      const f = fixture()
      void ai
      f.s.getAll.nextResolve(container as never)
      const error = await expectCode(f.ai.run('echo', INPUT), 'CONFIG_STORE_UNAVAILABLE')
      expect(error.retryable).toBe(true)
    }
  })

  it('never activates defaultRoute during an outage, and recovers after it', async () => {
    const { ai, s, p1 } = fixture()
    s.getAll.nextReject(new Error('down'))
    await expectCode(ai.run('echo', INPUT), 'CONFIG_STORE_UNAVAILABLE')
    expect(p1.requests.length).toBe(0)
    await ai.run('echo', INPUT) // the store is healthy again; nothing stale was cached
    expect(p1.requests.map((r) => r.model)).toEqual(['m1'])
    expect(getAllCount(s)).toBe(2)
  })

  it('stamps cache age at read completion, not read start', async () => {
    const { ai, s, runtime } = fixture()
    const gate = s.getAll.nextHang()
    const run = observe(ai.run('echo', INPUT))
    await flushMicrotasks()
    await runtime.advance(4000) // the read is slow: 4 s of its 5 s deadline
    gate.resolve({})
    await flushMicrotasks()
    expect(run.state).toBe('resolved')
    await runtime.advance(4000) // now 4 s after completion — stale only if stamped at start
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(1)
    await runtime.advance(1500) // 5.5 s after completion: genuinely stale
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(2)
  })
})

describe('generation coherence', () => {
  for (const [what, mutate] of [
    [
      'set success',
      async (f: ReturnType<typeof fixture>) =>
        f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' }),
    ],
    [
      'set rejection',
      async (f: ReturnType<typeof fixture>) => {
        f.s.set.nextReject(new Error('down'))
        await expectCode(
          f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' }),
          'CONFIG_STORE_UNAVAILABLE',
        )
      },
    ],
    ['delete success', async (f: ReturnType<typeof fixture>) => f.ai.resetConfig('echo')],
    [
      'delete rejection',
      async (f: ReturnType<typeof fixture>) => {
        f.s.del.nextReject(new Error('down'))
        await expectCode(f.ai.resetConfig('echo'), 'CONFIG_STORE_UNAVAILABLE')
      },
    ],
  ] as const) {
    it(`bumps and invalidates on ${what as string}`, async () => {
      const f = fixture()
      await f.ai.run('echo', INPUT)
      expect(getAllCount(f.s)).toBe(1)
      await (mutate as (f: ReturnType<typeof fixture>) => Promise<unknown>)(f)
      await f.ai.run('echo', INPUT) // still inside the TTL, but the entry was invalidated
      expect(getAllCount(f.s)).toBe(2)
    })
  }

  for (const method of ['set', 'delete'] as const) {
    it(`bumps and invalidates on ${method} timeout, and again on the late ack`, async () => {
      const f = fixture()
      await f.ai.run('echo', INPUT)
      const gate = method === 'set' ? f.s.set.nextHang() : f.s.del.nextHang()
      const mutation = observe(
        method === 'set'
          ? f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' })
          : f.ai.resetConfig('echo'),
      )
      await f.runtime.advance(10_000)
      expect(mutation.state).toBe('rejected')
      expect((mutation.error as LLMSwitchError).code).toBe('CONFIG_STORE_UNAVAILABLE')
      expect((mutation.error as LLMSwitchError).retryable).toBe(true)
      await f.ai.run('echo', INPUT) // invalidated by the timeout outcome
      expect(getAllCount(f.s)).toBe(2)
      gate.resolve(undefined) // the ack lands after the deadline released the mutex
      await flushMicrotasks()
      await f.ai.run('echo', INPUT) // the late ack invalidated the entry again
      expect(getAllCount(f.s)).toBe(3)
    })
  }

  it('lets no old slow read overwrite a newer entry (valid old row)', async () => {
    const f = fixture()
    const gate = f.s.getAll.nextHang()
    const oldRun = observe(f.ai.run('echo', INPUT)) // read begun under the old generation
    await flushMicrotasks()
    await f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' }) // bumps the generation
    f.s.getAll.always(() => ({ echo: { provider: 'p1', model: 'm-new' } }))
    await f.ai.run('echo', INPUT) // fresh read under the new generation, cached
    const reads = getAllCount(f.s)
    gate.resolve({ echo: { provider: 'p1', model: 'm-old' } })
    await flushMicrotasks()
    expect(oldRun.state).toBe('resolved') // the old run itself uses what it read
    await f.ai.run('echo', INPUT) // must come from the newer cache entry, not m-old
    expect(getAllCount(f.s)).toBe(reads)
    expect(f.p1.requests.at(-1)?.model).toBe('m-new')
  })

  it('lets no old no-row read negative-cache the default over a newer entry', async () => {
    const f = fixture()
    const gate = f.s.getAll.nextHang()
    const oldRun = observe(f.ai.run('echo', INPUT))
    await flushMicrotasks()
    await f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' })
    f.s.getAll.always(() => ({ echo: { provider: 'p1', model: 'm-new' } }))
    await f.ai.run('echo', INPUT)
    const reads = getAllCount(f.s)
    gate.resolve({}) // the old read finds no row — it must not install the default
    await flushMicrotasks()
    expect(oldRun.state).toBe('resolved')
    await f.ai.run('echo', INPUT)
    expect(getAllCount(f.s)).toBe(reads) // served by the newer entry
    expect(f.p1.requests.at(-1)?.model).toBe('m-new')
  })

  it('lets no old malformed-row read cache anything or evict the newer entry', async () => {
    const f = fixture()
    const gate = f.s.getAll.nextHang()
    const oldRun = observe(f.ai.run('echo', INPUT))
    await flushMicrotasks()
    await f.ai.setConfig('echo', { provider: 'p1', model: 'm-new' })
    f.s.getAll.always(() => ({ echo: { provider: 'p1', model: 'm-new' } }))
    await f.ai.run('echo', INPUT)
    const reads = getAllCount(f.s)
    gate.resolve({ echo: { provider: 'p1' } }) // malformed
    await flushMicrotasks()
    expect(oldRun.state).toBe('rejected')
    expect((oldRun.error as LLMSwitchError).code).toBe('INVALID_CONFIG')
    await f.ai.run('echo', INPUT)
    expect(getAllCount(f.s)).toBe(reads) // the newer entry survived
  })
})

describe('the mutation mutex', () => {
  it('releases at the deadline, and a queued store call gets its own full 10 s', async () => {
    const f = fixture()
    const gateA = f.s.set.nextHang()
    const gateB = f.s.set.nextHang()
    const a = observe(f.ai.setConfig('echo', { provider: 'p1', model: 'a' }))
    await flushMicrotasks()
    expect(f.s.set.calls.length).toBe(1) // A's store call started
    await f.runtime.advance(2000) // B enters at a pinned positive offset after A
    const b = observe(f.ai.setConfig('echo', { provider: 'p1', model: 'b' }))
    await flushMicrotasks()
    expect(f.s.set.calls.length).toBe(1) // B is queued behind the mutex
    await f.runtime.advance(8000) // A's store call reaches its deadline (10 s after it began)
    expect(a.state).toBe('rejected') // A's public promise rejects at the deadline …
    expect((a.error as LLMSwitchError).code).toBe('CONFIG_STORE_UNAVAILABLE')
    await flushMicrotasks()
    expect(f.s.set.calls.length).toBe(2) // … and B's set is observed …
    expect(b.state).toBe('pending') // … while A's store promise is still pending
    // B entered at t=2 s; a budget charged from method entry would expire at t=12 s.
    await f.runtime.advance(2000) // t = 12 s
    expect(b.state).toBe('pending') // still inside B's own store-call budget
    await f.runtime.advance(7999) // t = 19.999 s
    expect(b.state).toBe('pending')
    await f.runtime.advance(1) // t = 20 s: 10 s after B's store call began
    expect(b.state).toBe('rejected')
    expect((b.error as LLMSwitchError).code).toBe('CONFIG_STORE_UNAVAILABLE')
    void gateA
    void gateB
  })

  it('keeps operations independent: one hung mutation never blocks another operation', async () => {
    const f = twoOps()
    const gate = f.s.set.nextHang()
    const hung = observe(f.ai.setConfig('alpha', { provider: 'p1', model: 'a' }))
    await flushMicrotasks()
    expect(f.s.set.calls.length).toBe(1)
    await f.ai.setConfig('beta', { provider: 'p1', model: 'b' }) // proceeds immediately
    expect(f.s.set.calls.length).toBe(2)
    expect(hung.state).toBe('pending')
    void gate
  })
})

describe('numeric validation at createSwitch and setConfig (per-field §6 domains)', () => {
  function build(mutate: (config: Record<string, unknown>) => void): () => unknown {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const p1 = scriptedProvider()
    const config: Record<string, unknown> = {
      providers: { p1: p1.provider },
      operations: {
        echo: {
          input: ECHO_INPUT,
          output: ECHO_OUTPUT,
          prompt: () => 'p',
          defaultRoute: { provider: 'p1', model: 'm1' },
        },
      },
      stores: s.stores,
    }
    mutate(config)
    return () =>
      createSwitchCore(config as unknown as CreateSwitchConfig<OperationsMap>, runtime)
  }

  function expectFieldThrow(build_: () => unknown, field: string): void {
    let caught: unknown
    try {
      build_()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LLMSwitchError)
    expect((caught as LLMSwitchError).code).toBe('INVALID_CONFIG')
    expect((caught as LLMSwitchError).message).toContain(field)
  }

  const op = (config: Record<string, unknown>): Record<string, unknown> =>
    (config.operations as { echo: Record<string, unknown> }).echo

  const cases: {
    field: string
    place: (config: Record<string, unknown>, value: number) => void
    invalid: number[]
    valid: number[]
  }[] = [
    {
      field: 'configTtlMs',
      place: (config, value) => {
        config.configTtlMs = value
      },
      invalid: [Number.NaN, Infinity, -Infinity, -1, 300_001],
      valid: [0, 2500.5, 300_000], // a fractional TTL is a number, not a safe-int count
    },
    {
      field: 'timeoutMs',
      place: (config, value) => {
        op(config).timeoutMs = value
      },
      invalid: [Number.NaN, Infinity, 999, 600_001],
      valid: [1000, 1500.5, 600_000], // fractional accepted: §6 ranges it as a number
    },
    {
      field: 'quota.perDay',
      place: (config, value) => {
        op(config).quota = { perDay: value }
      },
      invalid: [Number.NaN, Infinity, -1, 1_000_001, 0.5, 2 ** 53],
      valid: [0, 1_000_000],
    },
    {
      field: 'maxOutputTokens',
      place: (config, value) => {
        op(config).defaultRoute = { provider: 'p1', model: 'm1', maxOutputTokens: value }
      },
      invalid: [0, 0.5, Number.NaN, 2 ** 53],
      valid: [1, 128_000],
    },
    {
      field: 'temperature',
      place: (config, value) => {
        op(config).defaultRoute = { provider: 'p1', model: 'm1', temperature: value }
      },
      invalid: [Number.NaN, -0.1, 2.1, Infinity],
      valid: [0, 0.7, 2],
    },
    {
      field: 'inputPerM',
      place: (config, value) => {
        config.pricing = { p1: { m1: { inputPerM: value, outputPerM: 1 } } }
      },
      invalid: [Number.NaN, -1, Infinity],
      valid: [0, 0.25, 2 ** 53 * 2], // pricing is finite ≥ 0, NOT a safe-int count
    },
  ]

  for (const { field, place, invalid, valid } of cases) {
    it(`rejects every out-of-domain ${field}, naming the field`, () => {
      for (const value of invalid) {
        expectFieldThrow(
          build((config) => {
            place(config, value)
          }),
          field.split('.').at(-1) ?? field,
        )
      }
    })
    it(`accepts every in-domain ${field} boundary`, () => {
      for (const value of valid) {
        expect(
          build((config) => {
            place(config, value)
          }),
        ).not.toThrow()
      }
    })
  }

  it('rejects out-of-domain numerics at setConfig, naming the field, before any store call', async () => {
    const f = fixture()
    for (const [route, field] of [
      [{ provider: 'p1', model: 'm', maxOutputTokens: 0 }, 'maxOutputTokens'],
      [{ provider: 'p1', model: 'm', temperature: 3 }, 'temperature'],
      [{ provider: 'p1', model: 'm', quota: { perDay: 0.5 } }, 'perDay'],
    ] as const) {
      const error = await expectCode(f.ai.setConfig('echo', route), 'INVALID_CONFIG')
      expect(error.message).toContain(field)
    }
    expect(f.s.set.calls.length).toBe(0)
  })
})

describe('the admin matrix', () => {
  it('getConfig bypasses the cache, does not populate it, and never prepares', async () => {
    let prepares = 0
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const provider = {
      prepare: () => {
        prepares += 1
        return { complete: () => Promise.resolve(okResponse()) }
      },
      complete: () => Promise.resolve(okResponse()),
    }
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers: { p1: provider },
        operations,
        stores: s.stores,
      },
      runtime,
    )
    await ai.getConfig()
    expect(getAllCount(s)).toBe(1)
    expect(prepares).toBe(0) // readiness is not probed
    await ai.run('echo', INPUT)
    expect(getAllCount(s)).toBe(2) // getConfig did not populate the cache
    await ai.getConfig()
    expect(getAllCount(s)).toBe(3) // and it does not honour the run's fresh entry either
  })

  it('getConfig reports stored/effective, including the malformed view', async () => {
    const { ai, s } = twoOps()
    s.getAll.always(() => ({
      alpha: { provider: 'p1', model: 'stored' },
      beta: { provider: 'p1' }, // malformed
    }))
    const view = await ai.getConfig()
    expect(view.alpha).toEqual({
      stored: { provider: 'p1', model: 'stored' },
      effective: { provider: 'p1', model: 'stored' },
    })
    expect(view.beta).toEqual({ stored: 'malformed', effective: null })
  })

  it('getConfig reports a missing row as stored null with the default effective', async () => {
    const { ai } = twoOps()
    const view = await ai.getConfig()
    expect(view.alpha).toEqual({
      stored: null,
      effective: { provider: 'p1', model: 'alpha-default' },
    })
  })

  it('setConfig is replace-only: the store receives exactly the validated route', async () => {
    const f = fixture()
    f.s.getAll.always(() => ({
      echo: { provider: 'p1', model: 'old', temperature: 1.5, quota: { perDay: 9 } },
    }))
    await f.ai.run('echo', { ...INPUT, subjectId: 'u' }) // the row with extras is cached
    await f.ai.setConfig('echo', { provider: 'p1', model: 'new' })
    expect(f.s.set.calls).toEqual([['echo', { provider: 'p1', model: 'new' }]]) // no merge
  })

  it('resetConfig deletes, so defaultRoute and its quota apply again', async () => {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const p1 = scriptedProvider()
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'default-m', quota: { perDay: 7 } },
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers: { p1: p1.provider },
        operations,
        stores: s.stores,
      },
      runtime,
    )
    s.getAll.nextResolve({ echo: { provider: 'p1', model: 'stored-m' } })
    await ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(p1.requests.at(-1)?.model).toBe('stored-m')
    expect(s.log.filter((e) => e.startsWith('reserve')).length).toBe(0) // stored row: no quota
    await ai.resetConfig('echo')
    expect(s.del.calls).toEqual([['echo']])
    s.getAll.nextResolve({}) // the row is gone
    await ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(p1.requests.at(-1)?.model).toBe('default-m')
    expect(s.log.filter((e) => e.startsWith('reserve u 7')).length).toBe(1) // default quota again
  })

  it('rejects unknown operations on every admin method with INVALID_INPUT', async () => {
    const { ai } = fixture()
    await expectCode(ai.setConfig('nope', { provider: 'p1', model: 'm' }), 'INVALID_INPUT')
    await expectCode(ai.resetConfig('nope'), 'INVALID_INPUT')
    await expectCode(ai.getQuota('nope', 'u'), 'INVALID_INPUT')
  })
})

describe('getQuota', () => {
  function quotaFixture() {
    return fixture({ quota: { perDay: 5 } })
  }

  it('rejects an empty subjectId with INVALID_INPUT before any store call', async () => {
    const f = quotaFixture()
    await expectCode(f.ai.getQuota('echo', ''), 'INVALID_INPUT')
    expect(f.s.log).toEqual([])
  })

  it('maps a config outage to CONFIG_STORE_UNAVAILABLE with snapshot not attempted', async () => {
    const f = quotaFixture()
    f.s.getAll.nextReject(new Error('down'))
    await expectCode(f.ai.getQuota('echo', 'u'), 'CONFIG_STORE_UNAVAILABLE')
    expect(f.s.log).toEqual(['getAll'])
  })

  it('maps a malformed row to INVALID_CONFIG, snapshot not attempted', async () => {
    const f = quotaFixture()
    f.s.getAll.nextResolve({ echo: { provider: 'p1' } })
    await expectCode(f.ai.getQuota('echo', 'u'), 'INVALID_CONFIG')
    expect(f.s.log).toEqual(['getAll'])
  })

  it('answers INVALID_INPUT when there is no effective quota', async () => {
    const f = fixture() // no declared quota, defaultRoute carries none
    await expectCode(f.ai.getQuota('echo', 'u'), 'INVALID_INPUT')
    expect(f.s.log.filter((e) => e.startsWith('snapshot')).length).toBe(0)
  })

  it('returns the snapshot view with remaining clamped at zero', async () => {
    const f = quotaFixture()
    f.s.snapshot.nextResolve({ used: 7, resetsAt: '2026-08-27T00:00:00.000Z' })
    const view = await f.ai.getQuota('echo', 'u')
    expect(view).toEqual({
      limit: 5,
      used: 7, // §4 rule 3: used may exceed the limit
      remaining: 0,
      resetsAt: '2026-08-27T00:00:00.000Z',
    })
  })

  it('honours a fresh cache and updates it', async () => {
    const f = quotaFixture()
    await f.ai.run('echo', { ...INPUT, subjectId: 'u' })
    const reads = getAllCount(f.s)
    await f.ai.getQuota('echo', 'u') // resolution served from the run's fresh entry
    expect(getAllCount(f.s)).toBe(reads)
    const f2 = quotaFixture()
    await f2.ai.getQuota('echo', 'u') // populates …
    await f2.ai.run('echo', { ...INPUT, subjectId: 'u' }) // … and the run reuses it
    expect(getAllCount(f2.s)).toBe(1)
  })

  it('spends its two §6a deadlines sequentially', async () => {
    const f = quotaFixture()
    const configGate = f.s.getAll.nextHang()
    const slow = observe(f.ai.getQuota('echo', 'u'))
    await flushMicrotasks()
    await f.runtime.advance(5000) // the 5 s getAll deadline
    expect(slow.state).toBe('rejected')
    expect((slow.error as LLMSwitchError).code).toBe('CONFIG_STORE_UNAVAILABLE')
    void configGate

    const f2 = quotaFixture()
    const snapshotGate = f2.s.snapshot.nextHang()
    const slow2 = observe(f2.ai.getQuota('echo', 'u'))
    await flushMicrotasks()
    await f2.runtime.advance(9999)
    expect(slow2.state).toBe('pending')
    await f2.runtime.advance(1) // the 10 s snapshot deadline, started at the snapshot call
    expect(slow2.state).toBe('rejected')
    expect((slow2.error as LLMSwitchError).code).toBe('USAGE_STORE_UNAVAILABLE')
    void snapshotGate
  })
})

describe('strict route validation at all three seats', () => {
  const badRoutes: { name: string; route: unknown }[] = [
    { name: 'an unknown field', route: { provider: 'p1', model: 'm', extra: 1 } },
    { name: 'an empty provider', route: { provider: '', model: 'm' } },
    { name: 'an empty model', route: { provider: 'p1', model: '' } },
    {
      name: 'a malformed fallback',
      route: { provider: 'p1', model: 'm', fallback: { provider: 'p1' } },
    },
    {
      name: 'a fallback with unknown fields',
      route: {
        provider: 'p1',
        model: 'm',
        fallback: { provider: 'p1', model: 'm', quota: { perDay: 1 } },
      },
    },
    {
      name: 'a quota of the wrong shape',
      route: { provider: 'p1', model: 'm', quota: { daily: 1 } },
    },
    {
      name: 'a quota out of range',
      route: { provider: 'p1', model: 'm', quota: { perDay: -1 } },
    },
    { name: 'an unregistered provider', route: { provider: 'ghost', model: 'm' } },
    {
      name: 'an unregistered fallback provider',
      route: { provider: 'p1', model: 'm', fallback: { provider: 'ghost', model: 'm' } },
    },
  ]

  for (const { name, route } of badRoutes) {
    it(`rejects ${name} at createSwitch (declared route)`, () => {
      const runtime = fakeRuntime()
      const s = scriptedStores()
      const p1 = scriptedProvider()
      expect(() =>
        createSwitchCore(
          {
            providers: { p1: p1.provider },
            operations: {
              echo: {
                input: ECHO_INPUT,
                output: ECHO_OUTPUT,
                prompt: () => 'p',
                defaultRoute: route,
              },
            },
            stores: s.stores,
          } as unknown as CreateSwitchConfig<OperationsMap>,
          runtime,
        ),
      ).toThrow(LLMSwitchError)
    })

    it(`rejects ${name} at setConfig, before any store call`, async () => {
      const f = fixture()
      await expectCode(f.ai.setConfig('echo', route as never), 'INVALID_CONFIG')
      expect(f.s.set.calls.length).toBe(0)
    })

    it(`treats ${name} in a stored row as malformed, isolated`, async () => {
      const f = fixture()
      f.s.getAll.nextResolve({ echo: route })
      const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
      expect(error.detectedAt).toBe('local')
      expect(f.s.log).toEqual(['getAll'])
    })
  }
})

describe('effective-quota precedence (spec §2 / §8)', () => {
  it('lets a route quota override the declared quota, through run and getQuota', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    f.s.getAll.always(() => ({ echo: { provider: 'p1', model: 'm1', quota: { perDay: 2 } } }))
    await f.ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(f.s.log.find((e) => e.startsWith('reserve'))).toBe('reserve u 2')
    const view = await f.ai.getQuota('echo', 'u')
    expect(view.limit).toBe(2)
  })

  it('falls back to the declared quota when the stored row has none', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    f.s.getAll.always(() => ({ echo: { provider: 'p1', model: 'm1' } }))
    await f.ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(f.s.log.find((e) => e.startsWith('reserve'))).toBe('reserve u 5')
    expect((await f.ai.getQuota('echo', 'u')).limit).toBe(5)
  })

  it('never inherits defaultRoute.quota through a stored row (a merging resolver fails)', async () => {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const p1 = scriptedProvider()
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        // No declared quota; the default route carries one.
        defaultRoute: { provider: 'p1', model: 'm1', quota: { perDay: 7 } },
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers: { p1: p1.provider },
        operations,
        stores: s.stores,
      },
      runtime,
    )
    s.getAll.always(() => ({ echo: { provider: 'p1', model: 'stored' } })) // no quota
    await ai.run('echo', { ...INPUT, subjectId: 'u' }) // non-quota: nothing inherited
    expect(s.log.filter((e) => e.startsWith('reserve')).length).toBe(0)
    await expectCode(ai.getQuota('echo', 'u'), 'INVALID_INPUT')
  })

  it('runs without a quota when neither route nor definition declares one', async () => {
    const f = fixture()
    await f.ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(f.s.log.filter((e) => e.startsWith('reserve')).length).toBe(0)
    await expectCode(f.ai.getQuota('echo', 'u'), 'INVALID_INPUT')
  })
})
