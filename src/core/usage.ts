/**
 * Usage normalization and the §7 aggregates.
 *
 * The universal rule: invalid usage never fails a run (it normalizes to `null`), and a
 * fabricated zero is never invented for a missing count. Aggregation sums only what was
 * reported, and says so through `usageComplete`.
 *
 * @module
 */

import type { z } from 'zod'
import type { AttemptRecord, ModelPrice, OperationDefinition, TokenUsage } from '../types'
import { isCount, isRecord } from './validate'

/** The registered prices, provider ID → model → price; built once at `createSwitch`. */
export type PricingTable = ReadonlyMap<string, ReadonlyMap<string, ModelPrice>>

/** The output format an operation declared, after `createSwitch` defaulted it. */
export type OutputFormat = NonNullable<OperationDefinition<z.ZodType, z.ZodType>['format']>

/**
 * Reads a provider-reported usage value once and answers a validated copy, or `null`.
 *
 * Both base counters must be non-negative safe integers; `imageOutputTokens`, when present,
 * a non-negative safe integer at most `outputTokens`. Anything else (wrong shape, wrong
 * type, negative, unsafe, a split larger than the whole) normalizes to `null` (spec §5b,
 * §7). An absent split stays absent: a zero is never invented.
 */
export function normalizeUsage(value: unknown): TokenUsage | null {
  try {
    if (!isRecord(value)) return null
    const { inputTokens, outputTokens, imageOutputTokens } = value
    if (!isCount(inputTokens) || !isCount(outputTokens)) return null
    if (imageOutputTokens === undefined) return { inputTokens, outputTokens }
    if (!isCount(imageOutputTokens) || imageOutputTokens > outputTokens) return null
    return { inputTokens, outputTokens, imageOutputTokens }
  } catch {
    return null
  }
}

/**
 * Prices one attempt (spec §7): tokens × per-million rates, by registered provider ID and
 * model, with image output tokens carved out of `outputTokens` at their own rate.
 *
 * `null` when there is no usage or no price, and under the three §7 rules: image tokens
 * reported against a price without an image rate; an image-format attempt whose usage has
 * output tokens but no split (pricing them at the text rate would be fabricated).
 */
export function priceAttempt(
  pricing: PricingTable,
  provider: string,
  model: string,
  usage: TokenUsage | null,
  format: OutputFormat,
): number | null {
  if (usage === null) return null
  const price = pricing.get(provider)?.get(model)
  if (price === undefined) return null
  const imageTokens = usage.imageOutputTokens
  if (imageTokens === undefined) {
    if (format === 'image' && usage.outputTokens > 0) return null
    return (
      (usage.inputTokens * price.inputPerM) / 1e6 +
      (usage.outputTokens * price.outputPerM) / 1e6
    )
  }
  if (imageTokens > 0 && price.imageOutputPerM === undefined) return null
  const textOut = usage.outputTokens - imageTokens
  return (
    (usage.inputTokens * price.inputPerM) / 1e6 +
    (textOut * price.outputPerM) / 1e6 +
    (imageTokens * (price.imageOutputPerM ?? 0)) / 1e6
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
 * dispatched attempt has usage and no base-field clamp fired. `imageOutputTokens` is
 * present iff at least one attempt has usage and every such attempt reports it. `cost` is
 * the summed per-attempt cost, `null` if any dispatched attempt lacks usage or a price.
 */
export function aggregateAttempts(attempts: readonly AttemptRecord[]): UsageAggregate {
  let inputTokens = 0
  let outputTokens = 0
  let imageOutputTokens = 0
  let clamped = false
  let everyUsage = true
  let anyUsage = false
  let everySplit = true
  let cost: number | null = 0
  for (const attempt of attempts) {
    if (attempt.usage === null) {
      everyUsage = false
    } else {
      anyUsage = true
      inputTokens += attempt.usage.inputTokens
      outputTokens += attempt.usage.outputTokens
      if (attempt.usage.imageOutputTokens === undefined) everySplit = false
      else imageOutputTokens += attempt.usage.imageOutputTokens
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
  const usage: TokenUsage = { inputTokens, outputTokens }
  // §7 presence rule: the split is summed only when every attempt with usage reports it;
  // a partial split is never summed and an all-null run never invents a zero.
  if (anyUsage && everySplit) {
    usage.imageOutputTokens = Math.min(imageOutputTokens, Number.MAX_SAFE_INTEGER)
  }
  return { usage, usageComplete: everyUsage && !clamped, cost }
}
