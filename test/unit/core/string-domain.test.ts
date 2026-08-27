/**
 * The §6 string domain: every persisted string type × each violation class at its
 * pinned boundary, with the per-origin no-dependent-call proof, the exact-1000-byte
 * positive oracle, and the valid-hostile keys that a prototype-unsafe registry would break.
 */

import { describe, expect, it } from 'vitest'

import { LLMDispatchError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import { settleDetached } from '../../../src/core/quota'
import type { CreateSwitchConfig, OperationsMap } from '../../../src/types'
import {
  expectCode,
  fakeRuntime,
  fixture,
  flushMicrotasks,
  scriptedProvider,
  scriptedStores,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT = { input: { text: 'hi' } }

/** The three violation classes of spec §6. */
const VIOLATIONS: { name: string; value: string }[] = [
  { name: 'a lone surrogate', value: 'x\uD800y' },
  { name: 'a U+0000', value: 'x\u0000y' },
  { name: 'more than 1000 UTF-8 bytes', value: 'é'.repeat(501) }, // 1002 bytes
]

function buildSwitch(config: Record<string, unknown>) {
  const runtime = fakeRuntime()
  const s = scriptedStores()
  const p1 = scriptedProvider()
  const full = {
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
    ...config,
  }
  return {
    s,
    p1,
    make: () => createSwitchCore(full as unknown as CreateSwitchConfig<OperationsMap>, runtime),
  }
}

function expectInvalidConfigThrow(make: () => unknown): void {
  let caught: unknown
  try {
    make()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LLMDispatchError)
  expect((caught as LLMDispatchError).code).toBe('INVALID_CONFIG')
}

describe('violations at the createSwitch boundary: no store method called at all', () => {
  for (const { name, value } of VIOLATIONS) {
    it(`rejects an operation name carrying ${name}`, () => {
      const { s, make } = buildSwitch({
        operations: {
          [value]: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: () => 'p' },
        },
      })
      expectInvalidConfigThrow(make)
      expect(s.log).toEqual([])
    })

    it(`rejects a provider registration ID carrying ${name}`, () => {
      const p = scriptedProvider()
      const { s, make } = buildSwitch({ providers: { [value]: p.provider } })
      expectInvalidConfigThrow(make)
      expect(s.log).toEqual([])
    })

    it(`rejects a declared route model carrying ${name}`, () => {
      const { s, make } = buildSwitch({
        operations: {
          echo: {
            input: ECHO_INPUT,
            output: ECHO_OUTPUT,
            prompt: () => 'p',
            defaultRoute: { provider: 'p1', model: value },
          },
        },
      })
      expectInvalidConfigThrow(make)
      expect(s.log).toEqual([])
    })

    it(`rejects a declared FALLBACK model carrying ${name}`, () => {
      const { s, make } = buildSwitch({
        operations: {
          echo: {
            input: ECHO_INPUT,
            output: ECHO_OUTPUT,
            prompt: () => 'p',
            defaultRoute: {
              provider: 'p1',
              model: 'm1',
              fallback: { provider: 'p1', model: value },
            },
          },
        },
      })
      expectInvalidConfigThrow(make)
      expect(s.log).toEqual([])
    })
  }
})

describe('violations at the setConfig boundary: no store method called', () => {
  for (const { name, value } of VIOLATIONS) {
    it(`rejects a route model carrying ${name}`, async () => {
      const f = fixture()
      await expectCode(
        f.ai.setConfig('echo', { provider: 'p1', model: value }),
        'INVALID_CONFIG',
      )
      expect(f.s.log).toEqual([])
    })
  }
})

describe('violations in a subjectId', () => {
  for (const { name, value } of VIOLATIONS) {
    it(`rejects ${name} in run with INVALID_INPUT, before reserve`, async () => {
      const f = fixture({ quota: { perDay: 5 } })
      const error = await expectCode(
        f.ai.run('echo', { ...INPUT, subjectId: value }),
        'INVALID_INPUT',
      )
      expect(error.retryable).toBe(false)
      // A config read may legitimately precede the check; reserve must not.
      expect(f.s.log.filter((entry) => entry.startsWith('reserve')).length).toBe(0)
    })

    it(`rejects ${name} in getQuota with INVALID_INPUT, before snapshot`, async () => {
      const f = fixture({ quota: { perDay: 5 } })
      await expectCode(f.ai.getQuota('echo', value), 'INVALID_INPUT')
      expect(f.s.log.filter((entry) => entry.startsWith('snapshot')).length).toBe(0)
    })
  }
})

describe('violations in store-originated values: no dependent call', () => {
  for (const { name, value } of VIOLATIONS) {
    it(`treats a stored row model carrying ${name} as a malformed row`, async () => {
      const f = fixture()
      f.s.getAll.nextResolve({ echo: { provider: 'p1', model: value } })
      const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
      expect(error.detectedAt).toBe('local')
      expect(f.s.log).toEqual(['getAll']) // nothing after the read
    })

    it(`treats a stored FALLBACK model carrying ${name} as a malformed row`, async () => {
      const f = fixture()
      f.s.getAll.nextResolve({
        echo: { provider: 'p1', model: 'm1', fallback: { provider: 'p2', model: value } },
      })
      const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
      expect(error.detectedAt).toBe('local')
      expect(f.s.log).toEqual(['getAll'])
    })

    it(`refuses an envelope reservationId carrying ${name} before commit`, async () => {
      const f = fixture({ quota: { perDay: 5 } })
      f.s.reserve.next((key) => ({
        ok: true,
        reservation: { reservationId: value, key, day: '2026-08-26' },
        expiresAt: '2026-08-26T00:02:00.000Z',
      }))
      await expectCode(
        f.ai.run('echo', { ...INPUT, subjectId: 'u' }),
        'USAGE_STORE_UNAVAILABLE',
      )
      expect(f.s.commit.calls.length).toBe(0)
      expect(f.s.settle.calls.length).toBe(0)
    })
  }

  it('never calls settle for a violating envelope or attempt at finalization', async () => {
    // Unreachable through the public API: reserve validates the envelope and the routes
    // validate every attempt string, so the §6 re-check is exercised at the seam itself.
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const hookCalls: unknown[] = []
    const awaited = settleDetached(
      {
        runtime,
        store: s.stores.usage,
        onSettlementError: (error) => {
          hookCalls.push(error)
        },
        logger: undefined,
      },
      {
        reservationId: 'r\u0000',
        key: { operation: 'echo', subjectId: 'u' },
        day: '2026-08-26',
      },
      'failed',
      [],
    )
    await awaited
    await runtime.advance(40_000) // the retries cannot repair a domain violation
    await flushMicrotasks()
    expect(s.settle.calls.length).toBe(0) // no store call, initial or retry
    expect(hookCalls.length).toBe(1) // the failure still reaches the hook
  })

  it('never calls settle for a violating attempt record behind a valid envelope', async () => {
    // The envelope passes; the attempt strings do not: the re-check must still refuse the
    // store call, and the failure still travels the retry-then-hook path.
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const hookCalls: unknown[] = []
    const awaited = settleDetached(
      {
        runtime,
        store: s.stores.usage,
        onSettlementError: (error) => {
          hookCalls.push(error)
        },
        logger: undefined,
      },
      { reservationId: 'r-ok', key: { operation: 'echo', subjectId: 'u' }, day: '2026-08-26' },
      'failed',
      [
        {
          provider: 'p1',
          model: 'm\u0000odel', // outside the §6 domain
          outcome: 'transient',
          usage: null,
          costUsd: null,
          durationMs: 5,
        },
      ],
    )
    await awaited
    await runtime.advance(40_000)
    await flushMicrotasks()
    expect(s.settle.calls.length).toBe(0)
    expect(hookCalls.length).toBe(1)
  })
})

describe('the 1000-byte boundary', () => {
  it('accepts a subjectId of exactly 1000 UTF-8 bytes end-to-end', async () => {
    const boundary = 'é'.repeat(500) // exactly 1000 bytes
    const f = fixture({ quota: { perDay: 5 } })
    const result = await f.ai.run('echo', { ...INPUT, subjectId: boundary })
    expect(result.data).toEqual({ answer: 'ok' })
    expect(f.s.reserve.calls[0]![0].subjectId).toBe(boundary)
    expect(f.s.settle.calls.length).toBe(1)
  })

  it('rejects a subjectId of 1001 bytes (an off-by-one implementation fails one of these)', async () => {
    const over = `a${'é'.repeat(500)}` // 1001 bytes
    const f = fixture({ quota: { perDay: 5 } })
    await expectCode(f.ai.run('echo', { ...INPUT, subjectId: over }), 'INVALID_INPUT')
  })
})

describe('valid-hostile keys', () => {
  for (const operation of ['', '__proto__', 'constructor', 'toString']) {
    it(`runs the operation named ${JSON.stringify(operation)} through definition, lookup, caching, getConfig and a full run`, async () => {
      const runtime = fakeRuntime()
      const s = scriptedStores()
      const p1 = scriptedProvider()
      const operations = {} as Record<string, unknown>
      Object.defineProperty(operations, operation, {
        value: {
          input: ECHO_INPUT,
          output: ECHO_OUTPUT,
          prompt: () => 'p',
          quota: { perDay: 5 },
          defaultRoute: { provider: 'p1', model: 'm1' },
        },
        enumerable: true,
        configurable: true,
        writable: true,
      })
      const ai = createSwitchCore(
        {
          providers: { p1: p1.provider },
          operations: operations as OperationsMap,
          stores: s.stores,
        },
        runtime,
      )
      const result = await ai.run(operation, { ...INPUT, subjectId: 'u' })
      expect(result.data).toEqual({ answer: 'ok' })
      await ai.run(operation, { ...INPUT, subjectId: 'u' }) // served from the cache
      expect(s.log.filter((entry) => entry === 'getAll').length).toBe(1)
      const view = await ai.getConfig()
      expect(Object.getOwnPropertyDescriptor(view, operation)?.value).toEqual({
        stored: null,
        effective: { provider: 'p1', model: 'm1' },
      })
      // An unknown name still resolves as unknown: the registry is not the prototype chain.
      await expectCode(ai.run('valueOf', INPUT), 'INVALID_INPUT')
    })
  }

  for (const providerId of ['__proto__', 'constructor', 'toString']) {
    it(`routes and dispatches through a provider registered as ${JSON.stringify(providerId)}`, async () => {
      const runtime = fakeRuntime()
      const s = scriptedStores()
      const p = scriptedProvider()
      const providers = {} as Record<string, unknown>
      Object.defineProperty(providers, providerId, {
        value: p.provider,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      const ai = createSwitchCore(
        {
          providers: providers as CreateSwitchConfig<OperationsMap>['providers'],
          operations: {
            echo: {
              input: ECHO_INPUT,
              output: ECHO_OUTPUT,
              prompt: () => 'p',
              defaultRoute: { provider: providerId, model: 'm1' },
            },
          },
          stores: s.stores,
        },
        runtime,
      )
      const result = await ai.run('echo', INPUT)
      expect(result.route.provider).toBe(providerId)
      expect(p.requests.length).toBe(1)
    })
  }

  it("registers '' as a provider ID but never routes to it (route provider is non-empty)", async () => {
    const p = scriptedProvider()
    const routed = scriptedProvider()
    const { make } = buildSwitch({ providers: { '': p.provider, p1: routed.provider } })
    expect(make).not.toThrow() // registrable as a map key …

    const { make: makeRouted } = buildSwitch({
      providers: { '': p.provider, p1: routed.provider },
      operations: {
        echo: {
          input: ECHO_INPUT,
          output: ECHO_OUTPUT,
          prompt: () => 'p',
          defaultRoute: { provider: '', model: 'm1' }, // … but never routable
        },
      },
    })
    expectInvalidConfigThrow(makeRouted)

    const f = fixture()
    await expectCode(f.ai.setConfig('echo', { provider: '', model: 'm' }), 'INVALID_CONFIG')
  })
})
