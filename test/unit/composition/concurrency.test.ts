/**
 * Prepared-dispatcher concurrency under load (spec §5a): N overlapping runs over one
 * shared provider registered as both primary and fallback, each run resolving its own
 * credential — proof that nothing prepared leaks across runs — plus store reconciliation
 * at quiescence, admin mutations racing in-flight runs, and a seeded stochastic smoke
 * over shuffled settlement orders. The scripted interleavings are the gate; the seeded
 * shuffle is evidence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LLMSwitchError } from '../../../src/errors'
import { createSwitch } from '../../../src/index'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { createMemoryStores } from '../../../src/stores/memory'
import type { OperationsMap, RunResult } from '../../../src/types'
import type { Observed } from '../core/helpers'
import { observe } from '../core/helpers'
import { jsonResponse } from '../providers/helpers'
import {
  mulberry32,
  openaiSuccess,
  recordingStores,
  runIndexOf,
  shuffled,
  until,
  wireFetch,
} from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One `echo` operation whose primary and fallback both route to provider `shared`. */
function loadOperations(perDay: number): OperationsMap {
  return {
    echo: {
      input: z.object({ text: z.string() }),
      output: z.string(),
      prompt: ({ text }: { text: string }) => `PROMPT:${text}`,
      format: 'text',
      quota: { perDay },
      defaultRoute: {
        provider: 'shared',
        model: 'primary-model',
        fallback: { provider: 'shared', model: 'fallback-model' },
      },
    },
  } as unknown as OperationsMap
}

describe('the alternating-credentials race', () => {
  const N = 32

  it('every request carries exactly its own run’s key; the store reconciles at quiescence', async () => {
    const wire = wireFetch()
    let currentKey = ''
    let resolverCalls = 0
    // One provider object shared by the primary and the fallback route: a factory or core
    // that memoizes the key or dispatcher on this object leaks a key across runs and fails
    // the per-request assertion below.
    const provider = openaiCompatible({
      apiKey: () => {
        resolverCalls += 1
        return currentKey
      },
    })
    const internal = createMemoryStores({})
    const recorded = recordingStores(internal.stores)
    const ai = createSwitch({
      providers: { shared: provider },
      operations: loadOperations(N),
      stores: recorded.stores,
    })

    // The interleaving script: each run is launched with its own key and held at its
    // dispatched request, so all N overlap at the attempt stage while the resolver order
    // stays deterministic.
    const runs: Observed<RunResult<unknown>>[] = []
    for (let i = 0; i < N; i += 1) {
      currentKey = `key-${String(i)}`
      runs.push(
        observe(ai.run('echo', { input: { text: `run-${String(i)}` }, subjectId: 'load' })),
      )
      await until(() => wire.calls.length === i + 1, `primary request ${String(i)}`)
    }
    expect(wire.calls).toHaveLength(N)
    // Once per run despite the primary and fallback sharing the provider: memoized within
    // a run (§5a), never cached across runs.
    expect(resolverCalls).toBe(N)

    // Even runs succeed on the primary; odd runs fail transient and go to the fallback.
    for (const [i, call] of wire.calls.slice(0, N).entries()) {
      expect(runIndexOf(call)).toBe(i)
      expect(call.body.model).toBe('primary-model')
      if (i % 2 === 0) call.respond(openaiSuccess(`answer-${String(i)}`))
      else call.respond(jsonResponse(503, { error: { message: 'overloaded' } }))
    }
    await until(() => wire.calls.length === N + N / 2, 'fallback requests')

    const fallbacks = wire.calls.slice(N)
    const oddIndexes = Array.from({ length: N / 2 }, (_, k) => 2 * k + 1)
    expect(fallbacks.map(runIndexOf).sort((a, b) => a - b)).toEqual(oddIndexes)
    for (const call of fallbacks) {
      expect(call.body.model).toBe('fallback-model')
      call.respond(openaiSuccess(`rescued-${String(runIndexOf(call))}`))
    }
    await until(() => runs.every((run) => run.state !== 'pending'), 'all runs settled')

    // The named oracle: every dispatched request — primary and fallback alike — carries
    // exactly the key its run resolved.
    for (const call of wire.calls) {
      expect(call.headers.authorization).toBe(`Bearer key-${String(runIndexOf(call))}`)
    }

    runs.forEach((run, i) => {
      expect(run.state).toBe('resolved')
      const result = run.value
      if (i % 2 === 0) {
        expect(result?.data).toBe(`answer-${String(i)}`)
        expect(result?.usedFallback).toBe(false)
        expect(result?.route).toEqual({ provider: 'shared', model: 'primary-model' })
        expect(result?.attempts.map((a) => a.outcome)).toEqual(['succeeded'])
      } else {
        expect(result?.data).toBe(`rescued-${String(i)}`)
        expect(result?.usedFallback).toBe(true)
        expect(result?.route).toEqual({ provider: 'shared', model: 'fallback-model' })
        expect(result?.attempts.map((a) => a.outcome)).toEqual(['transient', 'succeeded'])
      }
    })

    // Quiescence reconciliation: committed slots == runs that dispatched (the fallback
    // shares its run's slot, so attempts != slots), every committed slot observed settled,
    // and the public snapshot agrees — which also means zero reservations are left pending.
    expect(recorded.envelopes).toHaveLength(N)
    const key = { operation: 'echo', subjectId: 'load' }
    const snapshot = await recorded.stores.usage.snapshot(key)
    expect(snapshot.used).toBe(N)
    const day = recorded.envelopes[0]?.day ?? ''
    const inspection = await internal.controls.inspect(key, day)
    expect(inspection.reservations).toBe(N)
    expect(inspection.counter?.used).toBe(N)
    let attemptTotal = 0
    for (const [i, envelope] of recorded.envelopes.entries()) {
      const settled = await internal.controls.readSettled(envelope.reservationId)
      expect(settled).not.toBeNull()
      expect(settled?.outcome).toBe('succeeded')
      expect(settled?.attempts).toHaveLength(i % 2 === 0 ? 1 : 2)
      attemptTotal += settled?.attempts.length ?? 0
    }
    expect(attemptTotal).toBe(N + N / 2)
  })
})

describe('admin mutations racing in-flight runs', () => {
  it('every run resolves the write before it; nothing serves a stale cache entry', async () => {
    const wire = wireFetch()
    const provider = openaiCompatible({ apiKey: () => 'sk-admin' })
    const internal = createMemoryStores({})
    const operations = {
      echo: {
        input: z.object({ text: z.string() }),
        output: z.string(),
        prompt: ({ text }: { text: string }) => `PROMPT:${text}`,
        format: 'text',
        defaultRoute: { provider: 'shared', model: 'm-default' },
      },
    } as unknown as OperationsMap
    const ai = createSwitch({
      providers: { shared: provider },
      operations,
      stores: internal.stores,
    })

    const K = 16
    const runs: Observed<RunResult<unknown>>[] = []
    for (let i = 0; i < K; i += 1) {
      await ai.setConfig('echo', { provider: 'shared', model: `m-${String(i)}` })
      runs.push(observe(ai.run('echo', { input: { text: `run-${String(i)}` } })))
      await until(() => wire.calls.length === i + 1, `request ${String(i)}`)
      // The mutation's invalidation must beat the cache: without it this run would read
      // the entry the previous run installed and dispatch the previous model.
      expect(wire.calls[i]?.body.model).toBe(`m-${String(i)}`)
    }
    for (const call of wire.calls) call.respond(openaiSuccess('ok'))
    await until(() => runs.every((run) => run.state !== 'pending'), 'all runs settled')

    runs.forEach((run, i) => {
      expect(run.state).toBe('resolved')
      expect(run.value?.route.model).toBe(`m-${String(i)}`)
    })
    const view = await ai.getConfig()
    expect(view.echo?.effective?.model).toBe(`m-${String(K - 1)}`)
  })
})

describe('seeded stochastic smoke', () => {
  it('shuffled settlement over a mixed outcome draw: results coherent, store reconciled', async () => {
    // The seed is the whole reproduction recipe; the draw and both shuffles derive from it.
    const random = mulberry32(0x2105)
    const wire = wireFetch()
    const provider = openaiCompatible({ apiKey: () => 'sk-load' })
    const internal = createMemoryStores({})
    const recorded = recordingStores(internal.stores)
    const N = 32
    const ai = createSwitch({
      providers: { shared: provider },
      operations: loadOperations(N),
      stores: recorded.stores,
    })

    const runs: Observed<RunResult<unknown>>[] = []
    for (let i = 0; i < N; i += 1) {
      runs.push(
        observe(ai.run('echo', { input: { text: `run-${String(i)}` }, subjectId: 'smoke' })),
      )
    }
    await until(() => wire.calls.length === N, 'all primary requests')

    const primaryOutcome = new Map<number, 'success' | 'transient' | 'rate_limit'>()
    for (const call of shuffled(wire.calls.slice(0, N), random)) {
      const i = runIndexOf(call)
      const roll = random()
      if (roll < 0.5) {
        primaryOutcome.set(i, 'success')
        call.respond(openaiSuccess(`answer-${String(i)}`))
      } else if (roll < 0.75) {
        primaryOutcome.set(i, 'transient')
        call.respond(jsonResponse(503, { error: { message: 'overloaded' } }))
      } else {
        primaryOutcome.set(i, 'rate_limit')
        call.respond(jsonResponse(429, { error: { message: 'slow down' } }))
      }
    }
    const failed = [...primaryOutcome].filter(([, o]) => o !== 'success').map(([i]) => i)
    // The chosen seed must exercise both waves, or the smoke proves less than it claims.
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.length).toBeLessThan(N)
    await until(() => wire.calls.length === N + failed.length, 'fallback requests')

    const fallbackOutcome = new Map<number, 'success' | 'transient'>()
    for (const call of shuffled(wire.calls.slice(N), random)) {
      const i = runIndexOf(call)
      if (random() < 0.7) {
        fallbackOutcome.set(i, 'success')
        call.respond(openaiSuccess(`rescued-${String(i)}`))
      } else {
        fallbackOutcome.set(i, 'transient')
        call.respond(jsonResponse(503, { error: { message: 'still overloaded' } }))
      }
    }
    await until(() => runs.every((run) => run.state !== 'pending'), 'all runs settled')

    runs.forEach((run, i) => {
      const primary = primaryOutcome.get(i)
      if (primary === 'success') {
        expect(run.state).toBe('resolved')
        expect(run.value?.usedFallback).toBe(false)
        expect(run.value?.data).toBe(`answer-${String(i)}`)
      } else if (fallbackOutcome.get(i) === 'success') {
        expect(run.state).toBe('resolved')
        expect(run.value?.usedFallback).toBe(true)
        expect(run.value?.attempts.map((a) => a.outcome)).toEqual([primary, 'succeeded'])
      } else {
        expect(run.state).toBe('rejected')
        expect(run.error).toBeInstanceOf(LLMSwitchError)
        const error = run.error as LLMSwitchError
        expect(error.code).toBe('PROVIDER_FAILED')
        expect(error.retryable).toBe(true)
        expect(error.attempts?.map((a) => a.outcome)).toEqual([primary, 'transient'])
      }
    })

    // Reconciliation holds regardless of the draw: one slot per run, every slot settled,
    // and the settlement outcomes match the run results one for one.
    expect(recorded.envelopes).toHaveLength(N)
    const snapshot = await recorded.stores.usage.snapshot({
      operation: 'echo',
      subjectId: 'smoke',
    })
    expect(snapshot.used).toBe(N)
    const settledOutcomes = { succeeded: 0, failed: 0 }
    for (const envelope of recorded.envelopes) {
      const settled = await internal.controls.readSettled(envelope.reservationId)
      expect(settled).not.toBeNull()
      if (settled?.outcome === 'succeeded') settledOutcomes.succeeded += 1
      else settledOutcomes.failed += 1
    }
    const resolved = runs.filter((run) => run.state === 'resolved').length
    expect(settledOutcomes).toEqual({ succeeded: resolved, failed: N - resolved })
  })
})
