/**
 * The `prepare()`/`ApiKeyResolver` group, end to end through the shipped core (spec §5a):
 * empty/undefined key, a transient vs a plain resolver failure, the abort race over a
 * never-settling resolver, and both resolver call shapes on the success path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LLMSwitchError, ProviderError } from '../../../src/errors'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { memoryStores } from '../../../src/stores/memory'
import type {
  ApiKeyResolver,
  CreateSwitchConfig,
  OperationsMap,
  Provider,
  StorePair,
} from '../../../src/types'
import { createSwitch } from '../../../src/index'
import { flushMicrotasks, macrotask, watchUnhandled } from '../core/helpers'
import { installFetch, jsonResponse } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One `echo` operation, quota'd so a denied prepare's non-consumption is observable. */
function config(provider: Provider, stores: StorePair): CreateSwitchConfig<OperationsMap> {
  const operations = {
    echo: {
      input: z.object({}),
      output: z.string(),
      prompt: () => 'hi',
      format: 'text',
      quota: { perDay: 5 },
      defaultRoute: { provider: 'p1', model: 'm1' },
    },
  } as unknown as OperationsMap
  return { providers: { p1: provider }, operations, stores }
}

function run(provider: Provider, stores: StorePair, signal?: AbortSignal) {
  const ai = createSwitch(config(provider, stores))
  return ai.run(
    'echo',
    { input: {}, subjectId: 'u' },
    signal === undefined ? undefined : { signal },
  )
}

describe('empty or undefined resolved key', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
  ])(
    '%s key -> INVALID_CONFIG local, non-retryable, no quota consumed',
    async (_label, key) => {
      const stores = memoryStores()
      const provider = openaiCompatible({ apiKey: () => key })
      await expect(run(provider, stores)).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        retryable: false,
        detectedAt: 'local',
      })
      const snapshot = await stores.usage.snapshot({ operation: 'echo', subjectId: 'u' })
      expect(snapshot.used).toBe(0)
    },
  )
})

describe('a resolver that throws', () => {
  it("ProviderError('transient') -> INVALID_CONFIG, retryable true, cause chained", async () => {
    const stores = memoryStores()
    const thrown = new ProviderError('transient')
    const provider = openaiCompatible({
      apiKey: () => {
        throw thrown
      },
    })
    await expect(run(provider, stores)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LLMSwitchError &&
        error.code === 'INVALID_CONFIG' &&
        error.retryable &&
        error.cause === thrown,
    )
  })

  it('a plain sentinel Error -> INVALID_CONFIG, retryable false, that object chained by identity', async () => {
    const stores = memoryStores()
    const thrown = new Error('sentinel-resolver-failure')
    const provider = openaiCompatible({ apiKey: () => Promise.reject(thrown) })
    await expect(run(provider, stores)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LLMSwitchError &&
        error.code === 'INVALID_CONFIG' &&
        !error.retryable &&
        error.cause === thrown,
    )
  })
})

describe('abort over a never-settling resolver', () => {
  it('ends ABORTED promptly, and suppresses the resolver rejecting late', async () => {
    const watch = watchUnhandled()
    const stores = memoryStores()
    let rejectLate!: (error: unknown) => void
    const resolver: ApiKeyResolver = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject
      })
    const provider = openaiCompatible({ apiKey: resolver })
    const controller = new AbortController()
    const running = run(provider, stores, controller.signal)
    await flushMicrotasks()
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    rejectLate(new Error('late resolver failure'))
    await macrotask()
    await macrotask()
    expect(watch.seen).toEqual([])
    watch.stop()
  })
})

describe('success path', () => {
  it.each([
    ['a sync resolver', () => 'sk-sync'],
    ['an async resolver', () => Promise.resolve('sk-async')],
  ])('%s completes end to end', async (_label, resolver) => {
    installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }),
    )
    const stores = memoryStores()
    const provider = openaiCompatible({ apiKey: resolver })
    const result = await run(provider, stores)
    expect(result.data).toBe('hello')
  })
})
