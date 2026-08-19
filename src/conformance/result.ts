/**
 * The lifecycle every store conformance run follows, fixed here rather than in each suite so
 * two adopters cannot get different verdicts from the order their cases ran in.
 *
 * @module
 */

import type { ConformanceResult } from '../types'

export type { ConformanceResult } from '../types'

/** How a case says what it required. Every call adds at most one line to the report. */
export interface Expectations {
  /** Records `<case>: <expected> but <actual>` unless the claim held. */
  that(held: boolean, expected: string, actual: string): void
  /** Records a failure unless the two values are structurally equal. */
  equal(actual: unknown, expected: unknown, what: string): void
}

/**
 * Requires a call to be refused through a rejected promise.
 *
 * A store that threw before it returned one would break any caller that only attached a
 * `catch`, so the two are not the same answer.
 */
export async function rejects(
  call: () => Promise<unknown>,
  expect: Expectations,
  what: string,
): Promise<void> {
  let pending: Promise<unknown>
  try {
    pending = call()
  } catch {
    expect.that(false, `${what} to be refused with a rejected promise`, 'it threw instead')
    return
  }
  try {
    await pending
  } catch {
    // The rejection is what the case asked for; what it carries is the store's business.
    return
  }
  expect.that(false, `${what} to be refused`, 'it was accepted')
}

/** One named case. The name is the prefix of every failure it reports. */
export interface ConformanceCase<Controls> {
  name: string
  run(controls: Controls, expect: Expectations): Promise<void>
}

/**
 * A check that runs before the cases and stops the run when it fails.
 *
 * For an assumption every case depends on: one clear failure is worth more to whoever has to
 * fix it than a dozen consequences of the same thing. It answers `null` for anything it is not
 * sure about, so a store that is broken in some other way is still described case by case.
 */
export interface ConformancePreflight<Controls> {
  name: string
  check(controls: Controls): Promise<string | null>
}

/** Structural equality over the JSON-shaped values a store returns. */
export function deepEqual(actual: unknown, expected: unknown): boolean {
  // `===` for numbers, so a store that answers -0 where 0 was written still agrees; `Object.is`
  // everywhere else, so NaN is still no answer at all.
  if (typeof actual === 'number' && typeof expected === 'number') return actual === expected
  if (Object.is(actual, expected)) return true
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false
    return (
      actual.length === expected.length &&
      actual.every((item, index) => deepEqual(item, expected[index]))
    )
  }
  if (typeof actual !== 'object' || typeof expected !== 'object') return false
  if (actual === null || expected === null) return false
  // Two objects with no keys are not the same value if they are not the same kind of object. A
  // store that builds its rows without a prototype is still handing back plain data, though.
  if (isPlainObject(actual) || isPlainObject(expected)) {
    if (!isPlainObject(actual) || !isPlainObject(expected)) return false
  } else if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false
  const left = actual as Record<string, unknown>
  const right = expected as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

/** Plain data: an object literal, or one built with no prototype at all. */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/** A value as a report reads it; `withKind` also names what sort of object it is. */
function show(value: unknown, withKind = false): string {
  switch (typeof value) {
    case 'string':
      return `'${value}'`
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value)
    case 'bigint':
      return `${value.toString()}n`
    case 'object':
      return value === null ? 'null' : shown(value, withKind)
    case 'symbol':
    case 'function':
      return `a ${typeof value}`
  }
}

/** An object as a report reads it. */
function shown(value: object, withKind: boolean): string {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = 'a value that cannot be printed'
  }
  return withKind ? `${kindOf(value)} ${body}` : body
}

/** What an object was made from. */
function kindOf(value: object): string {
  if (Array.isArray(value)) return 'an array'
  if (isPlainObject(value)) return 'a plain object'
  const prototype: unknown = Object.getPrototypeOf(value)
  const constructor = (prototype as { constructor?: unknown }).constructor
  return typeof constructor === 'function' && constructor.name !== ''
    ? `a ${constructor.name}`
    : 'an object of another kind'
}

/** A thrown value as a report reads it. */
function thrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  return `a thrown ${typeof error}`
}

/** A thrown value in its own words, with nothing added. */
function reason(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return `a thrown ${typeof error}`
}

/** The preflight's failure line, or `null` when the run may go ahead. */
async function preflightFailure<Controls>(
  preflight: ConformancePreflight<Controls>,
  prepare: (controls: Controls) => Promise<void>,
  controls: Controls,
): Promise<string | null> {
  try {
    await prepare(controls)
    const problem = await preflight.check(controls)
    return problem === null ? null : `${preflight.name}: ${problem}`
  } catch {
    // Silence is right here: a store that cannot even be prepared or asked is not what this
    // check is about, and every case is about to report exactly what it could not do.
    return null
  }
}

/**
 * Runs a fixed list of cases against one implementation.
 *
 * @param create Called once. If it throws, nothing runs and the run reports why.
 * @param prepare Called before every case, including after one has failed.
 * @param cases The cases, in the order they always run in.
 * @param preflight Checked once before the cases; a failure ends the run there.
 */
export async function runCases<Controls>(
  create: () => Promise<Controls>,
  prepare: (controls: Controls) => Promise<void>,
  cases: readonly ConformanceCase<Controls>[],
  preflight?: ConformancePreflight<Controls>,
): Promise<ConformanceResult> {
  let controls: Controls
  try {
    controls = await create()
  } catch (error) {
    return { passed: false, failures: [`create: ${reason(error)}`], skipped: [] }
  }

  if (preflight !== undefined) {
    const stopped = await preflightFailure(preflight, prepare, controls)
    if (stopped !== null) return { passed: false, failures: [stopped], skipped: [] }
  }

  const failures: string[] = []
  for (const conformanceCase of cases) {
    const { name } = conformanceCase
    try {
      await prepare(controls)
    } catch (error) {
      failures.push(`${name}: reset failed: ${thrown(error)}`)
      continue
    }
    const expect: Expectations = {
      that(held, expected, actual) {
        if (!held) failures.push(`${name}: ${expected} but ${actual}`)
      },
      equal(actual, expected, what) {
        const held = deepEqual(actual, expected)
        // Two values that differ only in what they were made from print identically, and a
        // report that reads "to be X but it was X" tells nobody anything.
        const alike = !held && show(actual) === show(expected)
        expect.that(
          held,
          `${what} to be ${show(expected, alike)}`,
          `it was ${show(actual, alike)}`,
        )
      },
    }
    try {
      await conformanceCase.run(controls, expect)
    } catch (error) {
      failures.push(`${name}: the case to run to completion but it threw ${thrown(error)}`)
    }
  }

  // `skipped` stays empty: every store case applies to every store (spec §6b).
  return { passed: failures.length === 0, failures, skipped: [] }
}
