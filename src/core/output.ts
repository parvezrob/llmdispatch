/**
 * The output pipeline (spec §3): from a completed response's text to validated data.
 *
 * Termination is checked before content by the caller — this module only ever sees a
 * `kind: 'complete'` text. Parse and shape failures are output rejections (fallback-eligible);
 * a non-Zod exception from user transform code and anything wrong in the quality gate are the
 * user's own bugs, reported for settlement and then re-thrown raw.
 *
 * @module
 */

import { z } from 'zod'
import type { OperationDefinition, QualityVerdict } from '../types'
import { AbortRaceLost, raceWithAbort } from './abort'
import { isRecord } from './validate'

/** How processing one completed response ended. */
export type OutputResult =
  | { type: 'success'; data: unknown }
  | { type: 'rejected' }
  | { type: 'user-error'; outcome: 'output_schema_error' | 'quality_error'; error: unknown }
  | { type: 'aborted' }

/**
 * Whether a value is a Zod validation error, from any copy of Zod.
 *
 * `instanceof` covers the copy the core loaded; the structural check covers a schema from a
 * second copy (spec §3 keys the decision on `ZodError`, not on one module instance).
 */
export function isZodError(value: unknown): boolean {
  if (value instanceof z.ZodError) return true
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; issues?: unknown }
  return (
    (candidate.name === 'ZodError' || candidate.name === '$ZodError') &&
    Array.isArray(candidate.issues)
  )
}

/**
 * Strips a single whole-response code fence, if the entire text is one (spec §3).
 *
 * A fence somewhere inside the text is content, not wrapping, and stays.
 */
export function unwrapWholeResponseFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return match?.[1] ?? text
}

/** Whether a quality verdict has one of its two legal shapes (spec §3, §6). */
function isWellFormedVerdict(value: unknown): value is QualityVerdict {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  return value.ok === false && (value.reason === undefined || typeof value.reason === 'string')
}

/**
 * Runs the §3 pipeline over a completed response's text.
 *
 * @param text The response body, already known to be a string.
 * @param definition The operation, for `format`, `output` and `quality`.
 * @param parsedInput What the input schema produced, handed to the quality gate.
 * @param signal The caller's signal; `output.parseAsync` and `quality` are raced with it.
 */
export async function processOutput(
  text: string,
  definition: OperationDefinition<z.ZodType, z.ZodType>,
  parsedInput: unknown,
  signal: AbortSignal | undefined,
): Promise<OutputResult> {
  const format = definition.format ?? 'json'

  let candidate: unknown
  if (format === 'text') {
    candidate = text
  } else {
    const unwrapped = unwrapWholeResponseFence(text)
    try {
      candidate = JSON.parse(unwrapped)
    } catch {
      return { type: 'rejected' }
    }
    // §3: for 'json' the parsed value must be a non-null, non-array object.
    if (format === 'json' && !isRecord(candidate)) return { type: 'rejected' }
  }

  let data: unknown
  try {
    data = await raceWithAbort(definition.output.parseAsync(candidate), signal)
  } catch (error) {
    if (error instanceof AbortRaceLost) return { type: 'aborted' }
    if (isZodError(error)) return { type: 'rejected' }
    return { type: 'user-error', outcome: 'output_schema_error', error }
  }

  if (definition.quality !== undefined) {
    let verdict: unknown
    try {
      verdict = await raceWithAbort(
        Promise.resolve(definition.quality({ input: parsedInput, data })),
        signal,
      )
    } catch (error) {
      if (error instanceof AbortRaceLost) return { type: 'aborted' }
      return { type: 'user-error', outcome: 'quality_error', error }
    }
    if (!isWellFormedVerdict(verdict)) {
      return {
        type: 'user-error',
        outcome: 'quality_error',
        error: new TypeError(
          'the quality gate returned a malformed verdict: expected { ok: true } or { ok: false, reason? }',
        ),
      }
    }
    if (!verdict.ok) return { type: 'rejected' }
  }

  return { type: 'success', data }
}
