/**
 * Edge branches the main groups reach only through defence in depth: pre-aborted races,
 * hostile getters inside usage objects, synchronously throwing stores, and the remaining
 * shape-validation arms of `createSwitch` and the route validator.
 */

import { describe, expect, it } from 'vitest'

import { AbortRaceLost, raceWithAbort } from '../../../src/core/abort'
import { createSwitchCore } from '../../../src/core/create-switch'
import { normalizeUsage } from '../../../src/core/usage'
import { LLMDispatchError } from '../../../src/errors'
import type { OperationsMap } from '../../../src/types'
import {
  expectCode,
  fakeRuntime,
  fixture,
  scriptedProvider,
  scriptedStores,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT = { input: { text: 'hi' } }

describe('raceWithAbort with a signal that has already fired', () => {
  it('suppresses the promise and rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    const never = new Promise<never>(() => undefined)
    await expect(raceWithAbort(never, controller.signal)).rejects.toBeInstanceOf(AbortRaceLost)
  })

  it('passes the promise through untouched without a signal', async () => {
    await expect(raceWithAbort(Promise.resolve(7), undefined)).resolves.toBe(7)
  })
})

describe('hostile usage objects', () => {
  it('normalizes a usage object with a throwing getter to null', () => {
    const hostile = {}
    Object.defineProperty(hostile, 'inputTokens', {
      enumerable: true,
      get(): number {
        throw new Error('no reading')
      },
    })
    expect(normalizeUsage(hostile)).toBeNull()
  })

  it('clamps the output-token field independently of the input field', async () => {
    const f = fixture()
    f.p1.nextResolve({
      kind: 'truncated',
      text: '',
      usage: { inputTokens: 1, outputTokens: Number.MAX_SAFE_INTEGER },
    })
    f.p2.nextResolve({
      kind: 'complete',
      text: '{"answer":"ok"}',
      usage: { inputTokens: 2, outputTokens: 3 },
    })
    const result = await f.ai.run('echo', INPUT)
    expect(result.usage.outputTokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.usage.inputTokens).toBe(3)
    expect(result.usageComplete).toBe(false)
  })
})

describe('synchronously hostile stores', () => {
  it('maps a config store whose set throws synchronously like any rejection, and still bumps', async () => {
    const runtime = fakeRuntime()
    const p1 = scriptedProvider()
    const log: string[] = []
    const rawStore = {
      getAll: () => {
        log.push('getAll')
        return Promise.resolve({})
      },
      set: (): Promise<void> => {
        log.push('set')
        throw new Error('sync store bug')
      },
      delete: () => Promise.resolve(),
    }
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const s = scriptedStores()
    const ai = createSwitchCore(
      {
        providers: { p1: p1.provider },
        operations,
        stores: { config: rawStore, usage: s.stores.usage },
      },
      runtime,
    )
    await ai.run('echo', INPUT)
    await expectCode(
      ai.setConfig('echo', { provider: 'p1', model: 'm2' }),
      'CONFIG_STORE_UNAVAILABLE',
    )
    await ai.run('echo', INPUT) // the failed mutation still invalidated the cache
    expect(log.filter((entry) => entry === 'getAll').length).toBe(2)
  })

  it('maps a reserve answering a non-object to USAGE_STORE_UNAVAILABLE', async () => {
    const f = fixture({ quota: { perDay: 5 } })
    f.s.reserve.nextResolve(42)
    await expectCode(f.ai.run('echo', { ...INPUT, subjectId: 'u' }), 'USAGE_STORE_UNAVAILABLE')
  })
})

describe('the remaining createSwitch shape checks', () => {
  it('rejects a null config with INVALID_CONFIG rather than a raw TypeError', () => {
    let caught: unknown
    try {
      createSwitchCore(null as never, fakeRuntime())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LLMDispatchError)
    expect((caught as LLMDispatchError).code).toBe('INVALID_CONFIG')
    expect((caught as LLMDispatchError).message).toContain('config')
  })

  function build(config: Record<string, unknown>): () => unknown {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const p1 = scriptedProvider()
    return () =>
      createSwitchCore(
        {
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
        },
        runtime,
      )
  }

  const cases: { name: string; config: Record<string, unknown>; field: string }[] = [
    {
      name: 'a provider that is not an object',
      config: { providers: { bad: 42 } },
      field: 'bad',
    },
    {
      name: 'a provider without a complete function',
      config: { providers: { bad: {} } },
      field: 'complete',
    },
    {
      name: 'a provider whose prepare is not a function',
      config: { providers: { bad: { complete: () => undefined, prepare: 42 } } },
      field: 'prepare',
    },
    {
      name: 'an operation whose input is not a Zod schema',
      config: {
        operations: { echo: { input: {}, output: ECHO_OUTPUT, prompt: () => 'p' } },
      },
      field: 'input',
    },
    {
      name: 'an operation whose prompt is not a function',
      config: {
        operations: { echo: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: 'p' } },
      },
      field: 'prompt',
    },
    {
      name: 'an operation with an unknown format',
      config: {
        operations: {
          echo: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: () => 'p', format: 'xml' },
        },
      },
      field: 'format',
    },
    {
      name: 'an operation whose quality is not a function',
      config: {
        operations: {
          echo: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: () => 'p', quality: true },
        },
      },
      field: 'quality',
    },
    {
      name: 'a pricing entry with an out-of-domain outputPerM',
      config: { pricing: { p1: { m1: { inputPerM: 1, outputPerM: -1 } } } },
      field: 'outputPerM',
    },
    {
      name: 'a null operation definition',
      config: { operations: { echo: null } },
      field: 'operation definition',
    },
    {
      name: 'a null quota',
      config: {
        operations: {
          echo: { input: ECHO_INPUT, output: ECHO_OUTPUT, prompt: () => 'p', quota: null },
        },
      },
      field: 'quota',
    },
    {
      name: 'a null pricing entry',
      config: { pricing: { p1: { m1: null } } },
      field: 'm1',
    },
    {
      name: 'a missing config store',
      config: { stores: { usage: {} } },
      field: 'stores.config',
    },
    {
      name: 'a missing usage store',
      config: { stores: { config: {}, usage: null } },
      field: 'stores.usage',
    },
  ]

  for (const { name, config, field } of cases) {
    it(`rejects ${name}, naming ${field}`, () => {
      let caught: unknown
      try {
        build(config)()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LLMDispatchError)
      expect((caught as LLMDispatchError).code).toBe('INVALID_CONFIG')
      expect((caught as LLMDispatchError).message).toContain(field)
    })
  }
})

describe('readiness captured at registration', () => {
  it('dispatches through the validated complete after the provider object is mutated', async () => {
    const f = fixture()
    ;(f.p1.provider as { complete?: unknown }).complete = undefined
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(false) // no post-quota provider_unclassified
    expect(f.p1.completeCalls()).toBe(1)
  })
})

describe('the remaining route-validator arms', () => {
  const badRoutes: { name: string; route: unknown }[] = [
    { name: 'a non-object route', route: 'p1/m1' },
    { name: 'a non-object fallback', route: { provider: 'p1', model: 'm', fallback: 'x' } },
    {
      name: 'a fallback with a bad maxOutputTokens',
      route: {
        provider: 'p1',
        model: 'm',
        fallback: { provider: 'p1', model: 'm', maxOutputTokens: 0 },
      },
    },
    {
      name: 'a fallback with a bad temperature',
      route: {
        provider: 'p1',
        model: 'm',
        fallback: { provider: 'p1', model: 'm', temperature: 9 },
      },
    },
    { name: 'a non-object quota', route: { provider: 'p1', model: 'm', quota: 3 } },
    { name: 'a non-string model', route: { provider: 'p1', model: 42 } },
  ]
  for (const { name, route } of badRoutes) {
    it(`rejects ${name} at setConfig`, async () => {
      const f = fixture()
      await expectCode(f.ai.setConfig('echo', route as never), 'INVALID_CONFIG')
      expect(f.s.set.calls.length).toBe(0)
    })
  }

  it('accepts an explicit null fallback and every optional field together', async () => {
    const f = fixture()
    await f.ai.setConfig('echo', {
      provider: 'p1',
      model: 'm',
      maxOutputTokens: 100,
      temperature: 1.5,
      quota: { perDay: 3 },
      fallback: null,
    })
    expect(f.s.set.calls.length).toBe(1)
  })

  it('accepts a fallback carrying its own optional fields', async () => {
    const f = fixture()
    await f.ai.setConfig('echo', {
      provider: 'p1',
      model: 'm',
      fallback: { provider: 'p2', model: 'm2', maxOutputTokens: 5, temperature: 0.5 },
    })
    expect(f.s.set.calls.length).toBe(1)
  })
})
