/**
 * Sanitization: sentinel strings seeded into prompt text, input,
 * provider error messages and model output must never appear in any core-constructed field
 * of any `LLMDispatchError` — message, own enumerable properties, attempts, or the cause
 * chain — while an adopter's own thrown value passes into `cause` verbatim, which is the
 * documented scope boundary, not a leak. Logger payloads are swept too.
 */

import { describe, expect, it } from 'vitest'

import { LLMDispatchError, ProviderError } from '../../../src/errors'
import type { OperationsMap } from '../../../src/types'
import { createSwitchCore } from '../../../src/core/create-switch'
import {
  fakeRuntime,
  fixture,
  scriptedProvider,
  scriptedStores,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT_SENTINEL = 'SENTINEL_INPUT_7f3a'
const PROMPT_SENTINEL = 'SENTINEL_PROMPT_9c1d'
const OUTPUT_SENTINEL = 'SENTINEL_OUTPUT_2e8b'
const PROVIDER_SENTINEL = 'SENTINEL_PROVIDER_5d4c'

const DISPATCH_SENTINELS = [INPUT_SENTINEL, PROMPT_SENTINEL, OUTPUT_SENTINEL]

/** Every string reachable from a value: own enumerable props, arrays, plus `cause` chains. */
function reachableStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  if (seen.has(value)) return []
  seen.add(value)
  const found: string[] = []
  if (value instanceof Error) {
    found.push(value.message)
    if ('cause' in value) found.push(...reachableStrings(value.cause, seen))
  }
  for (const entry of Object.values(value)) {
    found.push(...reachableStrings(entry, seen))
  }
  return found
}

/** The same walk, excluding everything below `cause` — the core-constructed fields only. */
function coreConstructedStrings(error: LLMDispatchError): string[] {
  const found: string[] = [error.message]
  for (const [key, entry] of Object.entries(error)) {
    if (key === 'cause') continue
    found.push(...reachableStrings(entry))
  }
  if (error.attempts !== undefined) found.push(...reachableStrings(error.attempts))
  return found
}

function expectNoSentinels(strings: string[], sentinels: string[]): void {
  for (const sentinel of sentinels) {
    const hit = strings.find((value) => value.includes(sentinel))
    expect(hit, `sentinel ${sentinel} leaked into: ${hit ?? ''}`).toBeUndefined()
  }
}

/** A fixture whose every user-controlled surface carries a sentinel. */
function sentinelFixture(options: { quota?: { perDay: number } } = {}) {
  const loggerLines: unknown[][] = []
  const runtime = fakeRuntime()
  const s = scriptedStores()
  const p1 = scriptedProvider()
  const p2 = scriptedProvider()
  const operations = {
    echo: {
      input: ECHO_INPUT,
      output: ECHO_OUTPUT,
      prompt: ({ text }: { text: string }) => `${PROMPT_SENTINEL}:${text}`,
      ...(options.quota === undefined ? {} : { quota: options.quota }),
      defaultRoute: { provider: 'p1', model: 'm1', fallback: { provider: 'p2', model: 'm2' } },
    },
  } as unknown as OperationsMap
  const ai = createSwitchCore(
    {
      providers: { p1: p1.provider, p2: p2.provider },
      operations,
      stores: s.stores,
      logger: {
        info: (...args: unknown[]) => void loggerLines.push(args),
        warn: (...args: unknown[]) => void loggerLines.push(args),
        error: (...args: unknown[]) => void loggerLines.push(args),
      },
    },
    runtime,
  )
  return { ai, s, p1, p2, runtime, loggerLines }
}

const ARGS = { input: { text: INPUT_SENTINEL }, subjectId: 'u' }

describe('the sentinel sweep over the whole error matrix', () => {
  /** Each scenario produces one LLMDispatchError under sentinel-laden dispatch content. */
  const scenarios: {
    name: string
    postDispatch: boolean
    provoke: (f: ReturnType<typeof sentinelFixture>) => Promise<void> | void
  }[] = [
    {
      name: 'QUOTA_EXCEEDED',
      postDispatch: false,
      provoke: (f) => {
        f.s.reserve.nextResolve({ ok: false, used: 5, resetsAt: '2026-08-27T00:00:00.000Z' })
      },
    },
    {
      name: 'USAGE_STORE_UNAVAILABLE',
      postDispatch: false,
      provoke: (f) => {
        f.s.reserve.nextReject(new Error('store offline')) // a core-safe double
      },
    },
    {
      name: 'CONFIG_STORE_UNAVAILABLE',
      postDispatch: false,
      provoke: (f) => {
        f.s.getAll.nextReject(new Error('store offline'))
      },
    },
    {
      name: 'INVALID_CONFIG from a malformed row',
      postDispatch: false,
      provoke: (f) => {
        f.s.getAll.nextResolve({ echo: { provider: 'p1' } })
      },
    },
    {
      name: 'PROVIDER_FAILED with a sentinel-laden provider message',
      postDispatch: true,
      provoke: (f) => {
        f.p1.nextReject(
          new ProviderError('invalid_request', { status: 413, message: PROVIDER_SENTINEL }),
        )
        f.p2.nextReject(
          new ProviderError('invalid_request', { status: 413, message: PROVIDER_SENTINEL }),
        )
      },
    },
    {
      name: 'INVALID_CONFIG detectedAt provider',
      postDispatch: true,
      provoke: (f) => {
        f.p1.nextReject(new ProviderError('auth', { status: 401, message: PROVIDER_SENTINEL }))
      },
    },
    {
      name: 'OUTPUT_REJECTED with sentinel-laden output',
      postDispatch: true,
      provoke: (f) => {
        f.p1.nextResolve({ kind: 'complete', text: `not json ${OUTPUT_SENTINEL}`, usage: null })
        f.p2.nextResolve({ kind: 'complete', text: `not json ${OUTPUT_SENTINEL}`, usage: null })
      },
    },
    {
      name: 'OUTPUT_REJECTED after truncation carrying sentinel text',
      postDispatch: true,
      provoke: (f) => {
        f.p1.nextResolve({ kind: 'truncated', text: OUTPUT_SENTINEL, usage: null })
        f.p2.nextResolve({ kind: 'truncated', text: OUTPUT_SENTINEL, usage: null })
      },
    },
    {
      name: 'PROVIDER_FAILED after refusal',
      postDispatch: true,
      provoke: (f) => {
        f.p1.nextResolve({ kind: 'refused', text: OUTPUT_SENTINEL, usage: null })
      },
    },
  ]

  for (const { name, postDispatch, provoke } of scenarios) {
    it(`keeps every core-constructed field of ${name} free of dispatch content`, async () => {
      const f = sentinelFixture({ quota: { perDay: 5 } })
      f.s.settle.always(() => {
        throw new Error('settlement down') // drive the logger path too
      })
      await provoke(f)
      let caught: unknown
      try {
        await f.ai.run('echo', ARGS)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LLMDispatchError)
      const error = caught as LLMDispatchError
      // Core-constructed fields: no dispatch content, ever.
      expectNoSentinels(coreConstructedStrings(error), DISPATCH_SENTINELS)
      // The full chain, cause included: still no dispatch content with core-safe doubles —
      // the provider sentinel is permitted only inside a PRE-dispatch cause chain.
      expectNoSentinels(reachableStrings(error), DISPATCH_SENTINELS)
      if (postDispatch) {
        expect('cause' in error).toBe(false) // post-dispatch factories accept no cause
        expectNoSentinels(reachableStrings(error), [PROVIDER_SENTINEL])
      }
      // The logger sweep: every invocation's arguments, for every sentinel.
      await f.runtime.advance(40_000) // drive the detached settlement tail and its logging
      for (const line of f.loggerLines) {
        expectNoSentinels(reachableStrings(line), [...DISPATCH_SENTINELS, PROVIDER_SENTINEL])
      }
    })
  }

  it('permits a transient-prepare ProviderError only inside the pre-dispatch cause chain', async () => {
    const runtime = fakeRuntime()
    const s = scriptedStores()
    const prepareFailure = new ProviderError('transient', { message: PROVIDER_SENTINEL })
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => PROMPT_SENTINEL,
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const ai = createSwitchCore(
      {
        providers: {
          p1: {
            prepare: () => {
              throw prepareFailure
            },
            complete: () => Promise.reject(new Error('unused')),
          },
        },
        operations,
        stores: s.stores,
      },
      runtime,
    )
    let caught: unknown
    try {
      await ai.run('echo', ARGS)
    } catch (error) {
      caught = error
    }
    const error = caught as LLMDispatchError
    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(prepareFailure) // verbatim — prepare ran before the prompt
    expectNoSentinels(coreConstructedStrings(error), [...DISPATCH_SENTINELS, PROVIDER_SENTINEL])
  })

  it('shows the scope boundary: an adopter-thrown sentinel appears only inside the verbatim cause', async () => {
    const f = sentinelFixture({ quota: { perDay: 5 } })
    const adopterFailure = new Error(`the store logged the prompt: ${PROMPT_SENTINEL}`)
    f.s.reserve.nextReject(adopterFailure)
    let caught: unknown
    try {
      await f.ai.run('echo', ARGS)
    } catch (error) {
      caught = error
    }
    const error = caught as LLMDispatchError
    expect(error.code).toBe('USAGE_STORE_UNAVAILABLE')
    expect(error.cause).toBe(adopterFailure) // exactly what the adopter threw, verbatim
    // …and nowhere else: the core injected nothing.
    expectNoSentinels(coreConstructedStrings(error), [PROMPT_SENTINEL])
  })

  it('leaves unwrapped user exceptions outside the guarantee, object-identical', async () => {
    const bug = new Error(`my own bug: ${INPUT_SENTINEL}`)
    const f = fixture()
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => {
          throw bug
        },
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f2 = fixture({ operations })
    void f
    let caught: unknown
    try {
      await f2.ai.run('echo', { input: { text: 'x' } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(bug) // raw, by design (spec §1) — the user's bug in full
  })
})
