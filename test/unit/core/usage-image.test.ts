/**
 * The §7 rules the image split adds: `imageOutputTokens` normalization, the three pricing
 * rules with the split carved out of `outputTokens`, and the aggregate presence rule.
 */

import { describe, expect, it } from 'vitest'

import type { AttemptRecord, ModelPrice } from '../../../src/types'
import { aggregateAttempts, normalizeUsage, priceAttempt } from '../../../src/core/usage'
import type { PricingTable } from '../../../src/core/usage'

function table(price: ModelPrice): PricingTable {
  return new Map([['p', new Map([['m', price]])]])
}

const WITH_RATE = table({ inputPerM: 1000, outputPerM: 2000, imageOutputPerM: 40_000 })
const WITHOUT_RATE = table({ inputPerM: 1000, outputPerM: 2000 })

function attempt(usage: AttemptRecord['usage'], costUsd: number | null = 0): AttemptRecord {
  return { provider: 'p', model: 'm', outcome: 'succeeded', usage, costUsd, durationMs: 1 }
}

describe('normalizeUsage with the image split', () => {
  it('keeps a valid split and leaves an absent one absent', () => {
    expect(normalizeUsage({ inputTokens: 1, outputTokens: 5, imageOutputTokens: 5 })).toEqual({
      inputTokens: 1,
      outputTokens: 5,
      imageOutputTokens: 5,
    })
    expect(normalizeUsage({ inputTokens: 1, outputTokens: 5, imageOutputTokens: 0 })).toEqual({
      inputTokens: 1,
      outputTokens: 5,
      imageOutputTokens: 0,
    })
    expect(normalizeUsage({ inputTokens: 1, outputTokens: 5 })).toEqual({
      inputTokens: 1,
      outputTokens: 5,
    })
    expect(normalizeUsage({ inputTokens: 1, outputTokens: 5 })).not.toHaveProperty(
      'imageOutputTokens',
    )
  })

  it('normalizes the whole usage to null when the split is present and invalid', () => {
    for (const split of [6, -1, 1.5, '5', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        normalizeUsage({ inputTokens: 1, outputTokens: 5, imageOutputTokens: split }),
      ).toBeNull()
    }
  })
})

describe('priceAttempt', () => {
  it('carves the split out of outputTokens at the image rate', () => {
    const usage = { inputTokens: 100, outputTokens: 30, imageOutputTokens: 20 }
    expect(priceAttempt(WITH_RATE, 'p', 'm', usage, 'image')).toBeCloseTo(
      (100 * 1000) / 1e6 + (10 * 2000) / 1e6 + (20 * 40_000) / 1e6,
      12,
    )
  })

  it('prices a zero split at the text rate whether or not an image rate exists', () => {
    const usage = { inputTokens: 100, outputTokens: 30, imageOutputTokens: 0 }
    const expected = (100 * 1000) / 1e6 + (30 * 2000) / 1e6
    expect(priceAttempt(WITH_RATE, 'p', 'm', usage, 'image')).toBeCloseTo(expected, 12)
    expect(priceAttempt(WITHOUT_RATE, 'p', 'm', usage, 'image')).toBeCloseTo(expected, 12)
  })

  it('answers null for a positive split against a price without an image rate', () => {
    const usage = { inputTokens: 100, outputTokens: 30, imageOutputTokens: 1 }
    expect(priceAttempt(WITHOUT_RATE, 'p', 'm', usage, 'image')).toBeNull()
    expect(priceAttempt(WITHOUT_RATE, 'p', 'm', usage, 'json')).toBeNull()
  })

  it('answers null for an image-format attempt with output tokens and no split', () => {
    const usage = { inputTokens: 100, outputTokens: 30 }
    expect(priceAttempt(WITH_RATE, 'p', 'm', usage, 'image')).toBeNull()
    expect(priceAttempt(WITHOUT_RATE, 'p', 'm', usage, 'image')).toBeNull()
  })

  it('prices an image-format attempt with zero output tokens and no split by the input alone', () => {
    const usage = { inputTokens: 100, outputTokens: 0 }
    expect(priceAttempt(WITH_RATE, 'p', 'm', usage, 'image')).toBeCloseTo(
      (100 * 1000) / 1e6,
      12,
    )
  })

  it('prices usage without the split on every other format as before', () => {
    const usage = { inputTokens: 100, outputTokens: 30 }
    const expected = (100 * 1000) / 1e6 + (30 * 2000) / 1e6
    for (const format of ['json', 'json-any', 'text'] as const) {
      expect(priceAttempt(WITH_RATE, 'p', 'm', usage, format)).toBeCloseTo(expected, 12)
      expect(priceAttempt(WITHOUT_RATE, 'p', 'm', usage, format)).toBeCloseTo(expected, 12)
    }
  })

  it('still answers null without usage or without a price', () => {
    expect(priceAttempt(WITH_RATE, 'p', 'm', null, 'image')).toBeNull()
    expect(
      priceAttempt(WITH_RATE, 'p', 'other', { inputTokens: 1, outputTokens: 1 }, 'text'),
    ).toBeNull()
  })
})

describe('aggregateAttempts and the split presence rule', () => {
  it('sums the split when every attempt with usage reports it', () => {
    const aggregate = aggregateAttempts([
      attempt({ inputTokens: 1, outputTokens: 5, imageOutputTokens: 4 }),
      attempt(null, null),
      attempt({ inputTokens: 2, outputTokens: 6, imageOutputTokens: 6 }),
    ])
    expect(aggregate.usage).toEqual({ inputTokens: 3, outputTokens: 11, imageOutputTokens: 10 })
    expect(aggregate.usageComplete).toBe(false)
    expect(aggregate.cost).toBeNull()
  })

  it('omits the split when any attempt with usage lacks it', () => {
    const aggregate = aggregateAttempts([
      attempt({ inputTokens: 1, outputTokens: 5, imageOutputTokens: 4 }),
      attempt({ inputTokens: 2, outputTokens: 6 }),
    ])
    expect(aggregate.usage).toEqual({ inputTokens: 3, outputTokens: 11 })
    expect(aggregate.usage).not.toHaveProperty('imageOutputTokens')
    expect(aggregate.usageComplete).toBe(true)
  })

  it('never invents a split for an all-null or empty run', () => {
    expect(aggregateAttempts([attempt(null, null)]).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(aggregateAttempts([]).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(aggregateAttempts([]).usage).not.toHaveProperty('imageOutputTokens')
  })

  it('clamps the split like the base fields without touching usageComplete', () => {
    const max = Number.MAX_SAFE_INTEGER
    const aggregate = aggregateAttempts([
      attempt({ inputTokens: 0, outputTokens: max, imageOutputTokens: max }),
      attempt({ inputTokens: 0, outputTokens: 1, imageOutputTokens: 1 }),
    ])
    expect(aggregate.usage.outputTokens).toBe(max)
    expect(aggregate.usage.imageOutputTokens).toBe(max)
    expect(aggregate.usageComplete).toBe(false) // the base field clamped
  })
})
