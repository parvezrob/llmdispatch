/**
 * The run state machine: every outgoing transition of every stage, the quota effect of
 * each (asserted on the store call log), attempts presence, and the fallback obligations.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ProviderError } from '../../../src/errors'
import type { Provider, ProviderRequest } from '../../../src/types'
import {
  deferred,
  expectCode,
  expectSameRejection,
  fixture,
  flushMicrotasks,
  grantFor,
  okResponse,
  scriptedStores,
  fakeRuntime,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'
import { createSwitchCore } from '../../../src/core/create-switch'
import type { CreateSwitchConfig, OperationsMap } from '../../../src/types'

const INPUT = { input: { text: 'hi' } }

/** The text of a request a string-returning prompt callback normalized to one part. */
function soleText(request: ProviderRequest): string {
  const first = request.parts[0]
  return first?.type === 'text' ? first.text : ''
}

describe('stage 0: pre-aborted signal', () => {
  it('ends ABORTED before anything else, with no store call and no attempts', async () => {
    const { ai, s } = fixture()
    const controller = new AbortController()
    controller.abort()
    const error = await expectCode(
      ai.run('echo', INPUT, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.retryable).toBe(false)
    expect(error.attempts).toBeUndefined()
    expect(s.log).toEqual([])
  })
})

describe('stage 1: operation lookup', () => {
  it('rejects an unknown operation with INVALID_INPUT and touches nothing', async () => {
    const { ai, s } = fixture()
    const error = await expectCode(ai.run('nope', INPUT), 'INVALID_INPUT')
    expect(error.retryable).toBe(false)
    expect(error.attempts).toBeUndefined()
    expect(s.log).toEqual([])
  })
})

describe('stage 2: input parse', () => {
  it('maps a ZodError to INVALID_INPUT with no store call', async () => {
    const { ai, s } = fixture()
    const error = await expectCode(ai.run('echo', { input: { text: 42 } }), 'INVALID_INPUT')
    expect(error.retryable).toBe(false)
    expect(s.log).toEqual([])
  })

  it('passes a non-Zod exception from user transform code through unwrapped', async () => {
    const bug = new RangeError('user transform bug')
    const operations = {
      echo: {
        input: z.object({ text: z.string() }).transform(() => {
          throw bug
        }),
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const { ai, s } = fixture({ operations })
    await expectSameRejection(ai.run('echo', INPUT), bug)
    expect(s.log).toEqual([])
  })
})

describe('stage 3: declared-quota subject check', () => {
  it('requires a subject before any I/O when the definition declares a quota', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    const error = await expectCode(ai.run('echo', INPUT), 'MISSING_SUBJECT')
    expect(error.retryable).toBe(false)
    expect(s.log).toEqual([]) // ahead of the stage-4 read, not merely ahead of reserve
  })

  it('treats an empty subjectId as missing', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    await expectCode(ai.run('echo', { ...INPUT, subjectId: '' }), 'MISSING_SUBJECT')
    expect(s.log).toEqual([])
  })
})

describe('stage 4: config resolution', () => {
  it('maps a store outage to CONFIG_STORE_UNAVAILABLE, retryable, quota untouched', async () => {
    const { ai, s } = fixture()
    s.getAll.nextReject(new Error('down'))
    const error = await expectCode(ai.run('echo', INPUT), 'CONFIG_STORE_UNAVAILABLE')
    expect(error.retryable).toBe(true)
    expect(error.attempts).toBeUndefined()
    expect(s.log).toEqual(['getAll'])
  })

  it('maps a malformed stored row to INVALID_CONFIG, isolated, quota untouched', async () => {
    const { ai, s } = fixture()
    s.getAll.nextResolve({ echo: { provider: 'p1' } }) // no model
    const error = await expectCode(ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.retryable).toBe(false)
    expect(error.detectedAt).toBe('local')
    expect(s.log).toEqual(['getAll'])
  })

  it('rejects INVALID_CONFIG when there is no row and no defaultRoute', async () => {
    const operations = {
      echo: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: () => 'p' },
    } as unknown as OperationsMap
    const { ai } = fixture({ operations })
    const error = await expectCode(ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.retryable).toBe(false)
  })

  it('checks the subject after stage 4 for a route-enabled quota', async () => {
    const { ai, s } = fixture() // no declared quota
    s.getAll.nextResolve({ echo: { provider: 'p1', model: 'm1', quota: { perDay: 2 } } })
    await expectCode(ai.run('echo', INPUT), 'MISSING_SUBJECT')
    expect(s.log).toEqual(['getAll']) // the read happened; reserve did not
  })

  it('reports a config failure before MISSING_SUBJECT for a route-enabled quota', async () => {
    const { ai, s } = fixture() // no declared quota, no subject passed
    s.getAll.nextReject(new Error('down'))
    await expectCode(ai.run('echo', INPUT), 'CONFIG_STORE_UNAVAILABLE')
  })
})

describe('stage 5: readiness', () => {
  function preparingProvider(): {
    provider: Provider
    prepareCalls: number[]
    dispatchers: { requests: ProviderRequest[] }[]
    completeCalls: () => number
  } {
    let completes = 0
    const state = {
      prepareCalls: [] as number[],
      dispatchers: [] as { requests: ProviderRequest[] }[],
    }
    const provider: Provider = {
      prepare() {
        state.prepareCalls.push(state.prepareCalls.length)
        const requests: ProviderRequest[] = []
        const dispatcher = {
          requests,
          complete: (request: ProviderRequest) => {
            requests.push(request)
            return Promise.resolve(okResponse())
          },
        }
        state.dispatchers.push(dispatcher)
        return dispatcher
      },
      complete() {
        completes += 1
        return Promise.resolve(okResponse())
      },
    }
    return { provider, ...state, completeCalls: () => completes }
  }

  function build(
    providers: Record<string, Provider>,
    route: Record<string, unknown>,
    config: Partial<CreateSwitchConfig<OperationsMap>> = {},
  ) {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: ({ text }: { text: string }) => `PROMPT:${text}`,
        defaultRoute: route,
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers,
        operations,
        stores: s.stores,
        ...config,
      },
      runtime,
    )
    return { ai, s, runtime }
  }

  it('maps a malformed prepared dispatcher to INVALID_CONFIG local, not retryable', async () => {
    const provider: Provider = {
      prepare: () => ({}) as never,
      complete: () => Promise.resolve(okResponse()),
    }
    const { ai, s } = build({ p1: { ...provider } }, { provider: 'p1', model: 'm1' })
    const error = await expectCode(ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.retryable).toBe(false)
    expect(error.detectedAt).toBe('local')
    expect(s.log).toEqual(['getAll']) // no quota work after a readiness failure
  })

  it("maps a prepare() throwing ProviderError('transient') to INVALID_CONFIG retryable", async () => {
    const provider: Provider = {
      prepare: () => {
        throw new ProviderError('transient')
      },
      complete: () => Promise.resolve(okResponse()),
    }
    const { ai } = build({ p1: provider }, { provider: 'p1', model: 'm1' })
    const error = await expectCode(ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.retryable).toBe(true)
    expect(error.detectedAt).toBe('local')
  })

  it('maps any other prepare() failure to INVALID_CONFIG, not retryable', async () => {
    const failure = new Error('keys unreadable')
    const provider: Provider = {
      prepare: () => {
        throw failure
      },
      complete: () => Promise.resolve(okResponse()),
    }
    const { ai } = build({ p1: provider }, { provider: 'p1', model: 'm1' })
    const error = await expectCode(ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(failure)
  })

  it('prepares once per registration ID when both routes share one, and bypasses complete', async () => {
    const shared = preparingProvider()
    const { ai } = build(
      { p1: shared.provider },
      { provider: 'p1', model: 'm1', fallback: { provider: 'p1', model: 'm2' } },
    )
    const result = await ai.run('echo', INPUT)
    expect(result.data).toEqual({ answer: 'ok' })
    expect(shared.prepareCalls.length).toBe(1)
    expect(shared.completeCalls()).toBe(0) // the raw complete is bypassed
    expect(shared.dispatchers[0]!.requests.length).toBe(1)
  })

  it('prepares twice when one provider object is registered under two IDs', async () => {
    const shared = preparingProvider()
    const { ai } = build(
      { a: shared.provider, b: shared.provider },
      { provider: 'a', model: 'm1', fallback: { provider: 'b', model: 'm2' } },
    )
    await ai.run('echo', INPUT)
    expect(shared.prepareCalls.length).toBe(2) // keyed by registration ID, not identity
  })

  it('dispatches both attempts of one run through that run’s prepared dispatcher', async () => {
    const shared = preparingProvider()
    const { ai } = build(
      { p1: shared.provider },
      { provider: 'p1', model: 'm1', fallback: { provider: 'p1', model: 'm2' } },
    )
    // Primary fails transiently; the fallback must reuse the same run-scoped dispatcher.
    let first = true
    const provider = shared.provider
    const prepare = provider.prepare?.bind(provider)
    provider.prepare = () => {
      const dispatcher = prepare?.() as { requests: ProviderRequest[]; complete: unknown }
      dispatcher.complete = (request: ProviderRequest) => {
        dispatcher.requests.push(request)
        if (first) {
          first = false
          return Promise.reject(new ProviderError('transient'))
        }
        return Promise.resolve(okResponse())
      }
      return dispatcher as never
    }
    const result = await ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(shared.prepareCalls.length).toBe(1)
    expect(shared.dispatchers[0]!.requests.length).toBe(2) // both attempts, one dispatcher
    expect(shared.completeCalls()).toBe(0)
  })

  it('dispatches through the captured prepared complete after the dispatcher object is mutated', async () => {
    const shared = preparingProvider()
    const { ai } = build(
      { p1: shared.provider },
      { provider: 'p1', model: 'm1', fallback: { provider: 'p1', model: 'm2' } },
    )
    // The first dispatch strips `complete` off the prepared object; the memoized dispatcher
    // must keep dispatching through the callable captured at memoization time.
    const provider = shared.provider
    const prepare = provider.prepare?.bind(provider)
    provider.prepare = () => {
      const dispatcher = prepare?.() as { requests: ProviderRequest[]; complete: unknown }
      let first = true
      dispatcher.complete = (request: ProviderRequest) => {
        dispatcher.requests.push(request)
        if (first) {
          first = false
          dispatcher.complete = undefined
          return Promise.reject(new ProviderError('transient'))
        }
        return Promise.resolve(okResponse())
      }
      return dispatcher as never
    }
    const result = await ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(shared.dispatchers[0]!.requests.length).toBe(2)
  })

  it('gives two overlapping runs their own dispatchers', async () => {
    const gates = [deferred<undefined>(), deferred<undefined>()]
    const dispatchers: { requests: ProviderRequest[] }[] = []
    const provider: Provider = {
      async prepare() {
        const index = dispatchers.length
        const requests: ProviderRequest[] = []
        const dispatcher = {
          requests,
          complete: (request: ProviderRequest) => {
            requests.push(request)
            return Promise.resolve(okResponse())
          },
        }
        dispatchers.push(dispatcher)
        await gates[index]!.promise
        return dispatcher
      },
      complete: () => Promise.resolve(okResponse()),
    }
    const { ai } = build({ p1: provider }, { provider: 'p1', model: 'm1' })
    const runA = ai.run('echo', { input: { text: 'a' } })
    await flushMicrotasks()
    const runB = ai.run('echo', { input: { text: 'b' } })
    await flushMicrotasks()
    expect(dispatchers.length).toBe(2) // per run, not per switch
    gates[1]!.resolve(undefined)
    gates[0]!.resolve(undefined)
    await Promise.all([runA, runB])
    expect(dispatchers[0]!.requests.map(soleText)).toEqual(['PROMPT:a'])
    expect(dispatchers[1]!.requests.map(soleText)).toEqual(['PROMPT:b'])
  })
})

describe('stage 6: prompt build', () => {
  it('passes a thrown prompt exception through unwrapped, quota untouched', async () => {
    const bug = new Error('prompt bug')
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => {
          throw bug
        },
        quota: { perDay: 5 },
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const { ai, s } = fixture({ operations })
    await expectSameRejection(ai.run('echo', { ...INPUT, subjectId: 'u' }), bug)
    expect(s.log).toEqual(['getAll']) // config was read; reserve never was
  })

  it('throws a descriptive unwrapped TypeError for a non-string prompt return', async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 42,
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const { ai, s } = fixture({ operations })
    let caught: unknown
    try {
      await ai.run('echo', INPUT)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TypeError)
    expect((caught as TypeError).message).toContain('must return a string')
    expect((caught as TypeError).message).toContain('number')
    expect(s.log).toEqual(['getAll'])
  })
})

describe('stages 7 and 8: quota reserve and commit', () => {
  it('ends QUOTA_EXCEEDED on a denial, carrying the store resetsAt, no commit', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.reserve.nextResolve({ ok: false, used: 5, resetsAt: '2026-08-27T00:00:00.000Z' })
    const error = await expectCode(
      ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'QUOTA_EXCEEDED',
    )
    expect(error.retryable).toBe(false)
    expect(error.resetsAt).toBe('2026-08-27T00:00:00.000Z')
    expect(error.attempts).toBeUndefined()
    expect(s.log).toEqual(['getAll', 'reserve u 5'])
  })

  it('still calls reserve at limit 0: denial must be store-authoritative', async () => {
    const { ai, s } = fixture({ quota: { perDay: 0 } })
    s.reserve.nextResolve({ ok: false, used: 3, resetsAt: '2026-08-27T00:00:00.000Z' })
    await expectCode(ai.run('echo', { ...INPUT, subjectId: 'u' }), 'QUOTA_EXCEEDED')
    expect(s.reserve.calls).toEqual([[{ operation: 'echo', subjectId: 'u' }, 0]])
  })

  it('maps a reserve transport failure to USAGE_STORE_UNAVAILABLE, retryable', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.reserve.nextReject(new Error('down'))
    const error = await expectCode(
      ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'USAGE_STORE_UNAVAILABLE',
    )
    expect(error.retryable).toBe(true)
    expect(s.log).toEqual(['getAll', 'reserve u 5'])
  })

  it('rejects a malformed envelope before any commit', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.reserve.nextResolve({
      ok: true,
      reservation: {
        reservationId: 'r-x',
        key: { operation: 'other', subjectId: 'u' },
        day: '2026-08-26',
      },
      expiresAt: '2026-08-26T00:02:00.000Z',
    })
    await expectCode(ai.run('echo', { ...INPUT, subjectId: 'u' }), 'USAGE_STORE_UNAVAILABLE')
    expect(s.log).toEqual(['getAll', 'reserve u 5']) // no commit
  })

  it('ends QUOTA_EXCEEDED when the post-expiry re-reserve is denied', async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.commit.nextResolve('expired')
    s.reserve.next((key) => grantFor(key))
    s.reserve.nextResolve({ ok: false, used: 5, resetsAt: '2026-08-27T00:00:00.000Z' })
    const error = await expectCode(
      ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'QUOTA_EXCEEDED',
    )
    expect(error.resetsAt).toBe('2026-08-27T00:00:00.000Z')
    // reserve, commit → expired, second reserve, and nothing after the denial
    expect(s.log.filter((entry) => entry.startsWith('reserve')).length).toBe(2)
    expect(s.log.filter((entry) => entry.startsWith('settle')).length).toBe(0)
  })

  it("maps commit 'missing' to USAGE_STORE_UNAVAILABLE with no settle", async () => {
    const { ai, s } = fixture({ quota: { perDay: 5 } })
    s.commit.nextResolve('missing')
    await expectCode(ai.run('echo', { ...INPUT, subjectId: 'u' }), 'USAGE_STORE_UNAVAILABLE')
    expect(s.log.filter((entry) => entry.startsWith('settle')).length).toBe(0)
  })
})

describe('stages 9–11: attempts, fallback and finalization', () => {
  it('returns the primary result with route, usedFallback false and one attempt', async () => {
    const { ai, s, p1, p2 } = fixture({ quota: { perDay: 5 } })
    const result = await ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(result.data).toEqual({ answer: 'ok' })
    expect(result.route).toEqual({ provider: 'p1', model: 'm1' })
    expect(result.usedFallback).toBe(false)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
    expect(p1.requests.length).toBe(1)
    expect(p2.requests.length).toBe(0)
    expect(s.log).toEqual([
      'getAll',
      'reserve u 5',
      'commit r-' + lastReservation(s.log),
      'settle succeeded',
    ])
  })

  it('falls back once on an eligible failure and reports the fallback route', async () => {
    const { ai, s, p1 } = fixture({ quota: { perDay: 5 } })
    p1.nextReject(new ProviderError('transient', { status: 503 }))
    const result = await ai.run('echo', { ...INPUT, subjectId: 'u' })
    expect(result.route).toEqual({ provider: 'p2', model: 'm2' }) // always-primary reporting fails
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['transient', 'succeeded'])
    expect(result.attempts.map((a) => a.provider)).toEqual(['p1', 'p2']) // dispatch order
    expect(s.log.filter((entry) => entry.startsWith('reserve')).length).toBe(1) // same slot
    expect(s.log.at(-1)).toBe('settle succeeded')
  })

  it('never dispatches a second fallback attempt', async () => {
    const { ai, p1, p2 } = fixture({ quota: { perDay: 5 } })
    p1.nextReject(new ProviderError('transient'))
    p2.nextReject(new ProviderError('transient'))
    const error = await expectCode(
      ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'PROVIDER_FAILED',
    )
    expect(error.retryable).toBe(true)
    expect(error.attempts?.length).toBe(2)
    expect(p1.requests.length).toBe(1)
    expect(p2.requests.length).toBe(1)
  })

  it('does not fall back on an ineligible classification', async () => {
    const f = fixture()
    f.p1.nextResolve({ kind: 'refused', text: '', usage: { inputTokens: 1, outputTokens: 0 } })
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['refused'])
    expect(f.p2.requests.length).toBe(0)
  })

  it('settles failed with attempts when the final attempt fails', async () => {
    const f = fixture({ quota: { perDay: 5 }, fallback: false })
    f.p1.nextReject(new ProviderError('invalid_request', { status: 413 }))
    const error = await expectCode(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }),
      'PROVIDER_FAILED',
    )
    expect(f.s.log.at(-1)).toBe('settle failed')
    expect(f.s.settle.calls[0]![2].map((a) => a.outcome)).toEqual(['invalid_request'])
    expect(error.retryable).toBe(false)
    expect(error.attempts?.[0]?.status).toBe(413)
  })

  it('lets fallbackOnAuthOrModelNotFound rescue a primary auth failure', async () => {
    const f = fixture({ config: { fallbackOnAuthOrModelNotFound: true } })
    f.p1.nextReject(new ProviderError('auth', { status: 401 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    // The rescued primary contributes its record and the run raises no error at all.
    expect(result.attempts.map((a) => a.outcome)).toEqual(['auth', 'succeeded'])
  })

  it('keeps auth terminal without the flag, detectedAt provider', async () => {
    const f = fixture()
    f.p1.nextReject(new ProviderError('auth', { status: 401 }))
    const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.detectedAt).toBe('provider')
    expect(error.retryable).toBe(false)
    expect(f.p2.requests.length).toBe(0)
  })

  it('applies the flag to the primary attempt only', async () => {
    const f = fixture({ config: { fallbackOnAuthOrModelNotFound: true } })
    f.p1.nextReject(new ProviderError('transient'))
    f.p2.nextReject(new ProviderError('model_not_found', { status: 404 }))
    const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.detectedAt).toBe('provider') // final attempt's row
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient', 'model_not_found'])
    expect(f.p1.requests.length).toBe(1) // never a second fallback
    expect(f.p2.requests.length).toBe(1)
  })

  it('reclassifies unclassified failures as transient under treatUnclassifiedAsTransient', async () => {
    const f = fixture({ config: { treatUnclassifiedAsTransient: true } })
    f.p1.nextReject(new Error('some custom failure'))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts[0]?.outcome).toBe('transient')
  })

  it('keeps provider_unclassified terminal by default, not retryable', async () => {
    const f = fixture()
    f.p1.nextReject(new Error('some custom failure'))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['provider_unclassified'])
    expect(f.p2.requests.length).toBe(0)
  })
})

/** The reservation number the fixture's grant produced, read back from the log. */
function lastReservation(log: string[]): string {
  const entry = log.find((line) => line.startsWith('commit r-'))
  if (entry === undefined) throw new Error('no commit entry in the log')
  return entry.slice('commit r-'.length)
}
