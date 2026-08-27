/**
 * Usage normalization and the §7 aggregates.
 *
 * The universal rule: invalid usage never fails a run (it normalizes to `null`), and a
 * fabricated zero is never invented for a missing count. Aggregation sums only what was
 * reported, and says so through `usageComplete`.
 *
 * @module
 */

import type { AttemptRecord, ModelPrice, TokenUsage } from '../types'
import { isCount, isRecord } from './validate'

/** The registered prices, provider ID → model → price; built once at `createSwitch`. */
export type PricingTable = ReadonlyMap<string, ReadonlyMap<string, ModelPrice>>

/**
 * Reads a provider-reported usage value once and answers a validated copy, or `null`.
 *
 * Both counters must be non-negative safe integers; anything else (wrong shape, wrong
 * type, negative, unsafe) normalizes to `null` (spec §5b, §7).
 */
export function normalizeUsage(value: unknown): TokenUsage | null {
  try {
    if (!isRecord(value)) return null
    const { inputTokens, outputTokens } = value
    if (!isCount(inputTokens) || !isCount(outputTokens)) return null
    return { inputTokens, outputTokens }
  } catch {
    return null
  }
}

/**
 * Prices one attempt (spec §7): tokens × per-million rates, by registered provider ID and
 * model. No usage or no price → `null`.
 */
export function priceAttempt(
  pricing: PricingTable,
  provider: string,
  model: string,
  usage: TokenUsage | null,
): number | null {
  if (usage === null) return null
  const price = pricing.get(provider)?.get(model)
  if (price === undefined) return null
  return (
    (usage.inputTokens * price.inputPerM) / 1e6 + (usage.outputTokens * price.outputPerM) / 1e6
  )
}

/** What aggregating a run's attempts produced (spec §7). */
export interface UsageAggregate {
  usage: TokenUsage
  usageComplete: boolean
  cost: number | null
}

/**
 * Aggregates a run's dispatched attempts (spec §7).
 *
 * `usage` is the field-wise sum over attempts with non-null usage, `{0,0}` when none,
 * clamped field-wise to `Number.MAX_SAFE_INTEGER`. `usageComplete` is true iff every
 * dispatched attempt has usage and no clamp fired. `cost` is the summed per-attempt cost,
 * `null` if any dispatched attempt lacks usage or a price.
 */
export function aggregateAttempts(attempts: readonly AttemptRecord[]): UsageAggregate {
  let inputTokens = 0
  let outputTokens = 0
  let clamped = false
  let everyUsage = true
  let cost: number | null = 0
  for (const attempt of attempts) {
    if (attempt.usage === null) {
      everyUsage = false
    } else {
      inputTokens += attempt.usage.inputTokens
      outputTokens += attempt.usage.outputTokens
    }
    if (attempt.costUsd === null) cost = null
    else if (cost !== null) cost += attempt.costUsd
  }
  if (inputTokens > Number.MAX_SAFE_INTEGER) {
    inputTokens = Number.MAX_SAFE_INTEGER
    clamped = true
  }
  if (outputTokens > Number.MAX_SAFE_INTEGER) {
    outputTokens = Number.MAX_SAFE_INTEGER
    clamped = true
  }
  return {
    usage: { inputTokens, outputTokens },
    usageComplete: everyUsage && !clamped,
    cost,
  }
}
