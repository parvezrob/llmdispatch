/**
 * Usage and cost aggregation (spec §7): field-wise sums over non-null attempts, the
 * safe-integer clamp, `usageComplete`, per-attempt pricing, and null propagation to `cost`.
 */

import { describe, expect, it } from 'vitest'

import { ProviderError } from '../../../src/errors'
import type { ProviderResponse } from '../../../src/types'
import { expectCode, fixture } from './helpers'

const INPUT = { input: { text: 'hi' } }

const PRICING = {
  pricing: {
    p1: { m1: { inputPerM: 1000, outputPerM: 2000 } },
    p2: { m2: { inputPerM: 500, outputPerM: 500 } },
  },
}

function completeWith(
  usage: { inputTokens: number; outputTokens: number } | null,
): ProviderResponse {
  return { kind: 'complete', text: '{"answer":"ok"}', usage }
}

describe('aggregation', () => {
  it('sums usage field-wise across both attempts and prices each by provider and model', async () => {
    const f = fixture({ config: PRICING })
    f.p1.nextReject(new ProviderError('transient'))
    f.p2.nextResolve(completeWith({ inputTokens: 10, outputTokens: 5 }))
    const result = await f.ai.run('echo', INPUT)
    // The failed primary reported no usage; only the fallback contributes.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(result.usageComplete).toBe(false) // the primary attempt has usage null
    expect(result.cost).toBeNull() // a dispatched attempt without usage → cost null
    expect(result.attempts[0]!.costUsd).toBeNull()
    expect(result.attempts[1]!.costUsd).toBeCloseTo((10 * 500) / 1e6 + (5 * 500) / 1e6, 10)
  })

  it('reports complete usage and a summed cost when every dispatched attempt has both', async () => {
    const f = fixture({ config: PRICING })
    f.p1.nextResolve({
      kind: 'truncated',
      text: 'part',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    f.p2.nextResolve(completeWith({ inputTokens: 10, outputTokens: 5 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 8 })
    expect(result.usageComplete).toBe(true)
    const truncatedCost = (7 * 1000) / 1e6 + (3 * 2000) / 1e6 // billable failed attempt
    const successCost = (10 * 500) / 1e6 + (5 * 500) / 1e6
    expect(result.cost).toBeCloseTo(truncatedCost + successCost, 10)
  })

  it('aggregates {0,0} with usageComplete true for a single usage-bearing attempt of zero tokens', async () => {
    const f = fixture({ config: PRICING })
    f.p1.nextResolve(completeWith({ inputTokens: 0, outputTokens: 0 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(result.usageComplete).toBe(true)
    expect(result.cost).toBe(0)
  })

  it('aggregates {0,0} when no attempt reported usage, and cost is null', async () => {
    const f = fixture()
    f.p1.nextResolve(completeWith(null))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(result.usageComplete).toBe(false)
    expect(result.cost).toBeNull()
  })

  it('clamps a field-wise overflow to MAX_SAFE_INTEGER and clears usageComplete', async () => {
    const f = fixture({ config: PRICING })
    f.p1.nextResolve({
      kind: 'truncated',
      text: '',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    })
    f.p2.nextResolve(completeWith({ inputTokens: 10, outputTokens: 5 }))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usage.inputTokens).toBe(Number.MAX_SAFE_INTEGER) // clamped, not overflowed
    expect(result.usage.outputTokens).toBe(6) // the other field sums normally
    expect(result.usageComplete).toBe(false) // the clamp fired
  })

  it('propagates a missing price to a null aggregate cost', async () => {
    const f = fixture({ config: { pricing: { p1: { m1: { inputPerM: 1, outputPerM: 1 } } } } })
    f.p1.nextReject(new ProviderError('transient'))
    f.p2.nextResolve(completeWith({ inputTokens: 10, outputTokens: 5 })) // p2/m2: unpriced
    const result = await f.ai.run('echo', INPUT)
    expect(result.attempts[1]!.costUsd).toBeNull()
    expect(result.cost).toBeNull()
  })

  it('carries usage and cost on error attempts too', async () => {
    const f = fixture({ config: PRICING, fallback: false })
    f.p1.nextResolve({ kind: 'refused', text: '', usage: { inputTokens: 4, outputTokens: 0 } })
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.[0]?.usage).toEqual({ inputTokens: 4, outputTokens: 0 })
    expect(error.attempts?.[0]?.costUsd).toBeCloseTo((4 * 1000) / 1e6, 10)
  })
})
