/**
 * Validation at the edges: the §6 string domain, the §6 numeric ranges, and the strict
 * route shape.
 *
 * Everything here answers a problem description or `null` rather than throwing: the caller
 * knows which `LLMDispatchError` its boundary mints (`INVALID_CONFIG` at `createSwitch` and
 * `setConfig`, `INVALID_INPUT` for a `subjectId`, a malformed row for a stored route), and
 * one description per problem keeps the messages stable.
 *
 * @module
 */

import type { OperationRoute, RouteTarget } from '../types'

/** The §6 string-domain bound: 1 000 bytes of UTF-8. */
export const MAX_STORE_STRING_BYTES = 1000

const encoder = new TextEncoder()

/**
 * Why a value is outside the §6 string domain, or `null` when it is a string every store can
 * hold: well-formed Unicode, no U+0000, at most 1 000 UTF-8 bytes.
 */
export function storeStringProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string'
  if (!value.isWellFormed()) return 'must be well-formed Unicode'
  if (value.includes('\u0000')) return 'must not contain U+0000'
  if (encoder.encode(value).length > MAX_STORE_STRING_BYTES) {
    return `must be at most ${String(MAX_STORE_STRING_BYTES)} bytes of UTF-8`
  }
  return null
}

/**
 * Whether a value is a UTC calendar day written `YYYY-MM-DD`, years 0001–9999.
 *
 * Year 0000 is excluded (spec §4): PostgreSQL has no year zero, so a store that accepted it
 * would not be substitutable. The round trip rejects days that do not exist on the calendar.
 */
export function isStoreDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const at = Date.parse(`${value}T00:00:00.000Z`)
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value)
}

/** Whether a value parses as a timestamp, the way store `resetsAt`/`expiresAt` must. */
export function isParseableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Whether a value is a usable token or usage count: a non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** How a §6 numeric field is bounded; integers are checked with `Number.isSafeInteger`. */
interface NumberDomain {
  integer: boolean
  min: number
  max?: number
}

function numberProblem(value: unknown, domain: NumberDomain): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'must be a number'
  if (domain.integer && !Number.isSafeInteger(value)) return 'must be a safe integer'
  if (!domain.integer && !Number.isFinite(value)) return 'must be finite'
  if (value < domain.min) return `must be at least ${String(domain.min)}`
  if (domain.max !== undefined && value > domain.max) {
    return `must be at most ${String(domain.max)}`
  }
  return null
}

/** `configTtlMs`: a finite number of milliseconds, 0–300 000 (spec §6). */
export function configTtlMsProblem(value: unknown): string | null {
  return numberProblem(value, { integer: false, min: 0, max: 300_000 })
}

/** `timeoutMs`: a finite number of milliseconds, 1 000–600 000 (spec §6). */
export function timeoutMsProblem(value: unknown): string | null {
  return numberProblem(value, { integer: false, min: 1000, max: 600_000 })
}

/** `quota.perDay`: a safe integer, 0–1 000 000 (spec §6). */
export function perDayProblem(value: unknown): string | null {
  return numberProblem(value, { integer: true, min: 0, max: 1_000_000 })
}

/** `maxOutputTokens`: a safe integer, at least 1 (spec §6). */
export function maxOutputTokensProblem(value: unknown): string | null {
  return numberProblem(value, { integer: true, min: 1 })
}

/** `temperature`: finite, 0–2 (spec §6). */
export function temperatureProblem(value: unknown): string | null {
  return numberProblem(value, { integer: false, min: 0, max: 2 })
}

/** A price per million tokens: finite and non-negative; a count bound does not apply. */
export function priceProblem(value: unknown): string | null {
  return numberProblem(value, { integer: false, min: 0 })
}

/** Whether a value is a plain record the core may read fields from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a plain record and nothing else: prototype `null` or `Object.prototype`.
 *
 * The `getAll()` container is held to this stricter shape (§2 fail-closed): a `Map`, a
 * `Date`, or a class instance has no enumerable own rows, and reading one as "no rows"
 * would activate defaults during what is really an outage-shaped answer.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/** A route field in the §6 string domain and non-empty, or the reason it is not. */
function routeStringProblem(value: unknown, field: string): string | null {
  const domain = storeStringProblem(value)
  if (domain !== null) return `${field} ${domain}`
  if (value === '') return `${field} must be non-empty`
  return null
}

/** What a strict shape check answers: the validated plain copy, or what was wrong. */
export type Validated<T> = { ok: true; value: T } | { ok: false; problem: string }

/**
 * Copies a validated route so nothing outside the switch can mutate the original.
 *
 * Used wherever a route the switch holds (a declared `defaultRoute`, a cached row) is
 * handed to the adopter.
 */
export function cloneRoute(route: OperationRoute): OperationRoute {
  const copy: OperationRoute = { provider: route.provider, model: route.model }
  if (route.maxOutputTokens !== undefined) copy.maxOutputTokens = route.maxOutputTokens
  if (route.temperature !== undefined) copy.temperature = route.temperature
  if (route.quota !== undefined) copy.quota = { perDay: route.quota.perDay }
  if (route.fallback !== undefined) {
    copy.fallback = route.fallback === null ? null : { ...route.fallback }
  }
  return copy
}

const ROUTE_FIELDS = new Set([
  'provider',
  'model',
  'maxOutputTokens',
  'temperature',
  'quota',
  'fallback',
])
const TARGET_FIELDS = new Set(['provider', 'model', 'maxOutputTokens', 'temperature'])
const QUOTA_FIELDS = new Set(['perDay'])

/** The first own enumerable key outside `allowed`, or `null`. Unknown fields are malformed. */
function unknownField(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return key
  }
  return null
}

/**
 * Validates a `RouteTarget` strictly and answers a plain copy.
 *
 * Every property is read exactly once, and the copy holds those readings: the value a later
 * consumer sees is the value that was checked.
 */
export function validateRouteTarget(
  raw: unknown,
  registered: ReadonlySet<string>,
  field: string,
): Validated<RouteTarget> {
  if (!isRecord(raw)) return { ok: false, problem: `${field} must be an object` }
  const unknown = unknownField(raw, TARGET_FIELDS)
  if (unknown !== null) {
    return { ok: false, problem: `${field} has an unknown field "${unknown}"` }
  }
  const { provider, model, maxOutputTokens, temperature } = raw
  const providerProblem = routeStringProblem(provider, `${field}.provider`)
  if (providerProblem !== null) return { ok: false, problem: providerProblem }
  const modelProblem = routeStringProblem(model, `${field}.model`)
  if (modelProblem !== null) return { ok: false, problem: modelProblem }
  if (!registered.has(provider as string)) {
    return { ok: false, problem: `${field}.provider is not a registered provider` }
  }
  const target: RouteTarget = { provider: provider as string, model: model as string }
  if (maxOutputTokens !== undefined) {
    const problem = maxOutputTokensProblem(maxOutputTokens)
    if (problem !== null) return { ok: false, problem: `${field}.maxOutputTokens ${problem}` }
    target.maxOutputTokens = maxOutputTokens as number
  }
  if (temperature !== undefined) {
    const problem = temperatureProblem(temperature)
    if (problem !== null) return { ok: false, problem: `${field}.temperature ${problem}` }
    target.temperature = temperature as number
  }
  return { ok: true, value: target }
}

/**
 * Validates an `OperationRoute` strictly and answers a plain copy.
 *
 * The same validator serves all three seats: declared routes at `createSwitch`, the route
 * handed to `setConfig`, and rows read back from the config store, so a row a store returns
 * is held to exactly the shape an admin could have written (spec §2, §6).
 */
export function validateRoute(
  raw: unknown,
  registered: ReadonlySet<string>,
): Validated<OperationRoute> {
  if (!isRecord(raw)) return { ok: false, problem: 'must be an object' }
  const unknown = unknownField(raw, ROUTE_FIELDS)
  if (unknown !== null) return { ok: false, problem: `has an unknown field "${unknown}"` }
  const { provider, model, maxOutputTokens, temperature, quota, fallback } = raw
  const providerProblem = routeStringProblem(provider, 'provider')
  if (providerProblem !== null) return { ok: false, problem: providerProblem }
  const modelProblem = routeStringProblem(model, 'model')
  if (modelProblem !== null) return { ok: false, problem: modelProblem }
  if (!registered.has(provider as string)) {
    return { ok: false, problem: 'provider is not a registered provider' }
  }
  const route: OperationRoute = { provider: provider as string, model: model as string }
  if (maxOutputTokens !== undefined) {
    const problem = maxOutputTokensProblem(maxOutputTokens)
    if (problem !== null) return { ok: false, problem: `maxOutputTokens ${problem}` }
    route.maxOutputTokens = maxOutputTokens as number
  }
  if (temperature !== undefined) {
    const problem = temperatureProblem(temperature)
    if (problem !== null) return { ok: false, problem: `temperature ${problem}` }
    route.temperature = temperature as number
  }
  if (quota !== undefined) {
    if (!isRecord(quota)) return { ok: false, problem: 'quota must be an object' }
    const extra = unknownField(quota, QUOTA_FIELDS)
    if (extra !== null) return { ok: false, problem: `quota has an unknown field "${extra}"` }
    const { perDay } = quota
    const problem = perDayProblem(perDay)
    if (problem !== null) return { ok: false, problem: `quota.perDay ${problem}` }
    route.quota = { perDay: perDay as number }
  }
  if (fallback !== undefined) {
    if (fallback === null) {
      route.fallback = null
    } else {
      const target = validateRouteTarget(fallback, registered, 'fallback')
      if (!target.ok) return target
      route.fallback = target.value
    }
  }
  return { ok: true, value: route }
}
