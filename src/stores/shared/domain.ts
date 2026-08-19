/**
 * The domain every string a store persists has to be in (spec §6, "String domain").
 *
 * A relational store cannot hold every JavaScript string, so the contract bounds them and
 * both stores refuse the same values rather than silently altering them.
 *
 * @module
 */

import type { OperationRoute, QuotaKey, RouteTarget } from '../../types'

/** The contract's bound: 1 000 bytes of UTF-8. */
const MAX_BYTES = 1000

/**
 * The shape of a UTC calendar day (spec §6): four digits, two, two.
 *
 * Year 0000 is excluded because PostgreSQL has no year zero and rejects the date, where
 * JavaScript maps it to 1 BC and would take it.
 */
const DAY_PATTERN = /^(?!0000)\d{4}-\d{2}-\d{2}$/

const encoder = new TextEncoder()

/** A value a store cannot persist as it stands. The core maps it to the store's error code. */
export class StoreDomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreDomainError'
  }
}

/** Whether a string is one every store can hold verbatim. */
export function isStoreString(value: string): boolean {
  return (
    value.isWellFormed() &&
    !value.includes('\u0000') &&
    encoder.encode(value).length <= MAX_BYTES
  )
}

/**
 * Checks one string a store is about to persist.
 *
 * @param value The string as the caller supplied it.
 * @param field What to call it in the message.
 * @throws `StoreDomainError` when the value is outside the domain.
 */
export function assertStoreString(value: string, field: string): void {
  if (isStoreString(value)) return
  throw new StoreDomainError(
    `${field} must be well-formed Unicode, free of U+0000, and at most ${String(MAX_BYTES)} bytes of UTF-8`,
  )
}

/**
 * Checks a quota key and answers the copy the store is to use.
 *
 * Every property is read exactly once, and it is that reading which is checked and returned:
 * an object whose getter answers differently the second time cannot get one value past the
 * check and a different one into the tables.
 *
 * @param key The key as the caller supplied it.
 * @returns A plain key holding the checked values.
 * @throws `StoreDomainError` when either string is outside the domain.
 */
export function validatedKey(key: QuotaKey): QuotaKey {
  const { operation, subjectId } = key
  assertStoreString(operation, 'operation')
  assertStoreString(subjectId, 'subjectId')
  return { operation, subjectId }
}

/**
 * Checks a route target and answers the copy the store is to use.
 *
 * @param target The target as the caller supplied it.
 * @param field What to call it in the message.
 * @throws `StoreDomainError` when `provider` or `model` is outside the domain.
 */
function validatedTarget(target: RouteTarget, field: string): RouteTarget {
  const { provider, model, maxOutputTokens, temperature } = target
  assertStoreString(provider, `${field}.provider`)
  assertStoreString(model, `${field}.model`)
  const checked: RouteTarget = { provider, model }
  if (maxOutputTokens !== undefined) checked.maxOutputTokens = maxOutputTokens
  if (temperature !== undefined) checked.temperature = temperature
  return checked
}

/**
 * Checks a route and answers the copy the store is to persist.
 *
 * Every declared field is read once and copied; the same single-reading rule as for a key,
 * and the reason a store never persists a value the check did not see.
 *
 * @param route The route as the caller supplied it.
 * @returns A plain route holding the checked values.
 * @throws `StoreDomainError` when one of its strings is outside the domain.
 */
export function validatedRoute(route: OperationRoute): OperationRoute {
  const { provider, model, maxOutputTokens, temperature, quota, fallback } = route
  assertStoreString(provider, 'route.provider')
  assertStoreString(model, 'route.model')
  const checked: OperationRoute = { provider, model }
  if (maxOutputTokens !== undefined) checked.maxOutputTokens = maxOutputTokens
  if (temperature !== undefined) checked.temperature = temperature
  if (quota !== undefined) checked.quota = { perDay: quota.perDay }
  if (fallback !== undefined) {
    checked.fallback = fallback === null ? null : validatedTarget(fallback, 'route.fallback')
  }
  return checked
}

/**
 * Whether a value is a canonical `YYYY-MM-DD` UTC day.
 *
 * The day is a calendar date, not merely a string: a relational store types the column and
 * would refuse `2026-02-30` where a store keyed by strings would happily file it.
 */
export function isStoreDay(day: string): boolean {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return false
  const at = Date.parse(`${day}T00:00:00.000Z`)
  // A round trip, so a date that does not exist cannot survive by being parsed into one
  // that does.
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(day)
}

/**
 * Checks the day an envelope carries.
 *
 * @param day The day as the caller supplied it.
 * @throws `StoreDomainError` when it is not a canonical `YYYY-MM-DD` UTC day.
 */
export function assertStoreDay(day: string): void {
  if (isStoreDay(day)) return
  throw new StoreDomainError('day must be a UTC calendar day written as YYYY-MM-DD')
}
