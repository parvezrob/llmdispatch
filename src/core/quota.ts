/**
 * The quota lifecycle (spec §4): reserve, commit with recovery, and settlement.
 *
 * Every store return is validated fail-closed — the core never dispatches without a
 * validated `'committed'` — and the caller's signal is checked before every recovery I/O.
 * Settlement never changes a run's outcome: the initial `settle` is awaited to its deadline,
 * the retries are detached on unreferenced timers, and the failure hook and logger are
 * reached only through caught chains.
 *
 * @module
 */

import { aborted, quotaExceeded, usageStoreUnavailable } from '../errors'
import type {
  AttemptRecord,
  Logger,
  QuotaKey,
  ReservationEnvelope,
  SettlementFailure,
  UsageStore,
} from '../types'
import { callWithDeadline, sleepUnlessAborted } from './abort'
import type { CoreRuntime, TimerMode } from './runtime'
import {
  isCount,
  isParseableTimestamp,
  isRecord,
  isStoreDay,
  storeStringProblem,
} from './validate'

/** The §6a deadline for every usage-store call, including each settlement attempt. */
const USAGE_STORE_DEADLINE_MS = 10_000

/** The §4 commit transport-retry backoff. */
const COMMIT_RETRY_DELAYS_MS = [250, 500, 1000] as const

/** The §4 detached settlement-retry delays. */
const SETTLE_RETRY_DELAYS_MS = [1000, 5000, 25_000] as const

/** What the callers hand every function here. */
export interface QuotaContext {
  runtime: CoreRuntime
  store: UsageStore
  operation: string
  signal: AbortSignal | undefined
}

/**
 * Validates a `reserve` grant's envelope and answers a plain copy (spec §4, §6).
 *
 * The copy is what the run carries verbatim through commit recovery and settlement, so the
 * values checked here are the values every later store call sees.
 */
function envelopeProblem(
  value: unknown,
  key: QuotaKey,
): { envelope: ReservationEnvelope } | { problem: string } {
  if (!isRecord(value)) return { problem: 'reservation is not an object' }
  const { reservationId, key: envelopeKey, day } = value
  if (storeStringProblem(reservationId) !== null) {
    return { problem: 'reservationId is outside the string domain' }
  }
  if (!isRecord(envelopeKey)) return { problem: 'reservation key is not an object' }
  const { operation, subjectId } = envelopeKey
  if (operation !== key.operation || subjectId !== key.subjectId) {
    return { problem: 'reservation key does not match the requested key' }
  }
  if (!isStoreDay(day)) return { problem: 'reservation day is not a valid UTC calendar day' }
  return {
    envelope: {
      reservationId: reservationId as string,
      key: { operation: key.operation, subjectId: key.subjectId },
      day,
    },
  }
}

/** A store answer the §4 validation refused; chained as the `cause` of the public error. */
class MalformedStoreResult extends Error {
  constructor(call: string, problem: string) {
    super(`the usage store's ${call} answer was malformed: ${problem}`)
    this.name = 'MalformedStoreResult'
  }
}

/** A well-formed store answer the §4 recovery table maps to unavailability; also a `cause`. */
class QuotaRecoveryFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaRecoveryFailure'
  }
}

/**
 * Reserves the run's slot (spec §4, stage 7).
 *
 * Never raced with the signal — a reserve in flight is awaited to its deadline-bounded
 * result (§1); the caller checks the signal afterwards. `limit === 0` still reserves: the
 * denial's `used` and `resetsAt` must be store-authoritative.
 *
 * @throws `QUOTA_EXCEEDED` on a validated denial, `USAGE_STORE_UNAVAILABLE` on transport
 *   failure, timeout, or a malformed answer.
 */
export async function reserveSlot(
  ctx: QuotaContext,
  key: QuotaKey,
  limit: number,
): Promise<ReservationEnvelope> {
  const grant = await reserveOnce(ctx, key, limit)
  if (!grant.ok) throw quotaExceeded(ctx.operation, grant.resetsAt)
  return grant.envelope
}

/** One validated `reserve` call: a granted envelope or a validated denial. */
async function reserveOnce(
  ctx: QuotaContext,
  key: QuotaKey,
  limit: number,
): Promise<{ ok: true; envelope: ReservationEnvelope } | { ok: false; resetsAt: string }> {
  let answer: unknown
  try {
    answer = await callWithDeadline(
      ctx.runtime,
      USAGE_STORE_DEADLINE_MS,
      'usage store reserve()',
      'referenced',
      () => ctx.store.reserve(key, limit),
    )
  } catch (error) {
    // The awaited call has settled; the abort rule now wins over the failure (§1).
    checkRecoverySignal(ctx)
    throw usageStoreUnavailable(ctx.operation, error)
  }
  // §1: an in-flight reserve is awaited to its result first — then, before that result is
  // interpreted, an abort ends the run. Whatever state was reached stands: a granted
  // envelope simply expires on its own; a denial changed nothing.
  checkRecoverySignal(ctx)
  if (!isRecord(answer)) {
    throw usageStoreUnavailable(
      ctx.operation,
      new MalformedStoreResult('reserve()', 'not an object'),
    )
  }
  const { ok } = answer
  if (ok === true) {
    const { reservation, expiresAt } = answer
    const checked = envelopeProblem(reservation, key)
    if ('problem' in checked) {
      throw usageStoreUnavailable(
        ctx.operation,
        new MalformedStoreResult('reserve()', checked.problem),
      )
    }
    if (!isParseableTimestamp(expiresAt)) {
      throw usageStoreUnavailable(
        ctx.operation,
        new MalformedStoreResult('reserve()', 'expiresAt is not a parseable timestamp'),
      )
    }
    return { ok: true, envelope: checked.envelope }
  }
  if (ok === false) {
    const { used, resetsAt } = answer
    if (!isCount(used)) {
      throw usageStoreUnavailable(
        ctx.operation,
        new MalformedStoreResult('reserve()', 'denial used is not a non-negative safe integer'),
      )
    }
    if (!isParseableTimestamp(resetsAt)) {
      throw usageStoreUnavailable(
        ctx.operation,
        new MalformedStoreResult('reserve()', 'denial resetsAt is not a parseable timestamp'),
      )
    }
    return { ok: false, resetsAt }
  }
  throw usageStoreUnavailable(
    ctx.operation,
    new MalformedStoreResult('reserve()', 'ok is not a boolean'),
  )
}

/** Throws the plain pre-dispatch `ABORTED` when the caller's signal has fired. */
function checkRecoverySignal(ctx: QuotaContext): void {
  if (ctx.signal?.aborted === true) throw aborted(ctx.operation)
}

/**
 * Commits the reservation, running the §4 recovery table, and answers the envelope the run
 * settles against — the original, or the replacement after a single re-reserve.
 *
 * The signal is checked before every recovery I/O; an in-flight call is always awaited to
 * its deadline-bounded result first (§1).
 *
 * @throws `ABORTED` at a pre-I/O signal check, `QUOTA_EXCEEDED` on a denied re-reserve,
 *   `USAGE_STORE_UNAVAILABLE` everywhere the table says so.
 */
export async function commitWithRecovery(
  ctx: QuotaContext,
  envelope: ReservationEnvelope,
  key: QuotaKey,
  limit: number,
): Promise<ReservationEnvelope> {
  const first = await commitWithTransportRetries(ctx, envelope.reservationId)
  if (first === 'committed') return envelope
  if (first === 'missing') {
    throw usageStoreUnavailable(
      ctx.operation,
      new QuotaRecoveryFailure(
        'commit() answered missing: the reservation is unknown to the store',
      ),
    )
  }
  // 'expired' → re-reserve once (§4): a new envelope replaces the active one.
  checkRecoverySignal(ctx)
  const again = await reserveOnce(ctx, key, limit)
  if (!again.ok) throw quotaExceeded(ctx.operation, again.resetsAt)
  checkRecoverySignal(ctx)
  const second = await commitWithTransportRetries(ctx, again.envelope.reservationId)
  if (second === 'committed') return again.envelope
  throw usageStoreUnavailable(
    ctx.operation,
    new QuotaRecoveryFailure(`commit() of the replacement reservation answered '${second}'`),
  )
}

/**
 * One commit with the §4 transport-retry arm: transport error or timeout retries the same
 * id up to three times (250/500/1000 ms), each behind a signal check; a malformed answer is
 * fail-closed immediately, never retried.
 */
async function commitWithTransportRetries(
  ctx: QuotaContext,
  reservationId: string,
): Promise<'committed' | 'expired' | 'missing'> {
  let lastError: unknown
  for (let attempt = 0; attempt <= COMMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = COMMIT_RETRY_DELAYS_MS[attempt - 1] ?? 0
      const waited = await sleepUnlessAborted(ctx.runtime, delay, ctx.signal)
      if (waited === 'aborted') throw aborted(ctx.operation)
    }
    checkRecoverySignal(ctx)
    let answer: unknown
    try {
      answer = await callWithDeadline(
        ctx.runtime,
        USAGE_STORE_DEADLINE_MS,
        'usage store commit()',
        'referenced',
        () => ctx.store.commit(reservationId),
      )
    } catch (error) {
      // The awaited call has settled; the abort rule wins over the transport failure (§1).
      checkRecoverySignal(ctx)
      lastError = error
      continue
    }
    // A validated 'committed' counts (§1): the run proceeds into the post-commit region,
    // whose first boundary check reports the abort — with settlement. Every other answer
    // yields to the abort before it is interpreted.
    if (answer === 'committed') return answer
    checkRecoverySignal(ctx)
    if (answer === 'expired' || answer === 'missing') return answer
    throw usageStoreUnavailable(
      ctx.operation,
      new MalformedStoreResult('commit()', 'not one of committed, expired, missing'),
    )
  }
  throw usageStoreUnavailable(ctx.operation, lastError)
}

/**
 * Reads a validated usage snapshot for `getQuota` (spec §2, §4).
 *
 * @throws `USAGE_STORE_UNAVAILABLE` on transport failure, timeout, or a malformed answer.
 */
export async function readSnapshot(
  ctx: QuotaContext,
  key: QuotaKey,
): Promise<{ used: number; resetsAt: string }> {
  let answer: unknown
  try {
    answer = await callWithDeadline(
      ctx.runtime,
      USAGE_STORE_DEADLINE_MS,
      'usage store snapshot()',
      'referenced',
      () => ctx.store.snapshot(key),
    )
  } catch (error) {
    throw usageStoreUnavailable(ctx.operation, error)
  }
  if (!isRecord(answer)) {
    throw usageStoreUnavailable(
      ctx.operation,
      new MalformedStoreResult('snapshot()', 'not an object'),
    )
  }
  const { used, resetsAt } = answer
  if (!isCount(used)) {
    throw usageStoreUnavailable(
      ctx.operation,
      new MalformedStoreResult('snapshot()', 'used is not a non-negative safe integer'),
    )
  }
  if (!isParseableTimestamp(resetsAt)) {
    throw usageStoreUnavailable(
      ctx.operation,
      new MalformedStoreResult('snapshot()', 'resetsAt is not a parseable timestamp'),
    )
  }
  return { used, resetsAt }
}

/** What settlement needs beyond the run's own context. */
export interface SettlementContext {
  runtime: CoreRuntime
  store: UsageStore
  onSettlementError:
    ((error: unknown, record: SettlementFailure) => void | Promise<void>) | undefined
  logger: Logger | undefined
}

/** The stable message `logger.error` carries when settlement finally fails. */
export const SETTLEMENT_FAILED_MESSAGE =
  'llmswitch: settlement failed after every retry; attempt records were not persisted'

/** The §6 string-domain re-check before `settle` (spec §6): envelope and attempt strings. */
function settlementDomainProblem(
  envelope: ReservationEnvelope,
  attempts: readonly AttemptRecord[],
): string | null {
  if (storeStringProblem(envelope.reservationId) !== null) {
    return 'reservationId is outside the string domain'
  }
  if (
    storeStringProblem(envelope.key.operation) !== null ||
    storeStringProblem(envelope.key.subjectId) !== null
  ) {
    return 'reservation key is outside the string domain'
  }
  if (!isStoreDay(envelope.day)) return 'reservation day is not a valid UTC calendar day'
  for (const attempt of attempts) {
    if (
      storeStringProblem(attempt.provider) !== null ||
      storeStringProblem(attempt.model) !== null
    ) {
      return 'an attempt record is outside the string domain'
    }
  }
  return null
}

/**
 * Settles the run's slot (spec §4, stage 11) and never lets the result leak into the run.
 *
 * The returned promise is the awaited part: the initial `settle`, bounded by its 10 s
 * deadline, resolving whether or not that call succeeded. On failure, up to three retries
 * run on detached unreferenced timers — the process may exit before them (§4) — and if all
 * fail, `onSettlementError` and `logger.error` each run once through a caught chain.
 *
 * `attempts` must already be the run's own snapshot: the caller's arrays are reachable from
 * the public result and must not be able to change what is persisted.
 */
export function settleDetached(
  ctx: SettlementContext,
  envelope: ReservationEnvelope,
  outcome: 'succeeded' | 'failed',
  attempts: AttemptRecord[],
): Promise<void> {
  const attemptOnce = (mode: TimerMode): Promise<void> => {
    const problem = settlementDomainProblem(envelope, attempts)
    if (problem !== null) {
      // No store call at all: the store would refuse these values, and retrying cannot
      // change them. The failure still travels the normal retry-then-hook path.
      return Promise.reject(new MalformedStoreResult('settle()', problem))
    }
    return callWithDeadline(
      ctx.runtime,
      USAGE_STORE_DEADLINE_MS,
      'usage store settle()',
      mode,
      () => ctx.store.settle(envelope, outcome, attempts),
    )
  }

  const finalFailure = async (error: unknown): Promise<void> => {
    const record: SettlementFailure = { reservation: envelope, outcome, attempts }
    // Alongside, not instead of, each other; each caught and dropped exactly once. A hook
    // that never resolves must not stop the logger, so both start before either is awaited.
    const hook = Promise.resolve()
      .then(() => ctx.onSettlementError?.(error, record))
      .catch(() => undefined)
    const logged = Promise.resolve()
      .then(() => ctx.logger?.error(SETTLEMENT_FAILED_MESSAGE, record))
      .catch(() => undefined)
    await hook
    await logged
  }

  const scheduleRetry = (index: number, lastError: unknown): void => {
    if (index === SETTLE_RETRY_DELAYS_MS.length) {
      // Terminal catch attached synchronously: finalFailure cannot reject, but nothing
      // downstream of a detached tail may ever be able to surface.
      finalFailure(lastError).catch(() => undefined)
      return
    }
    ctx.runtime.schedule(
      () => {
        attemptOnce('unreferenced').then(
          () => undefined,
          (error: unknown) => {
            scheduleRetry(index + 1, error)
          },
        )
      },
      SETTLE_RETRY_DELAYS_MS[index] ?? 0,
      'unreferenced',
    )
  }

  return attemptOnce('referenced').then(
    () => undefined,
    (error: unknown) => {
      scheduleRetry(0, error)
    },
  )
}
