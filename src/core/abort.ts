/**
 * The abort race and the deadline race: the two ways the core stops waiting.
 *
 * Both are built on `Promise.race`, which keeps a reaction attached to the losing side, so a
 * user callback or store call that fails after the run has moved on never surfaces as an
 * unhandled rejection (spec §1). Rejection values pass through untouched: an unwrapped user
 * exception has to reach the caller object-identical.
 *
 * @module
 */

import type { CoreRuntime, TimerMode } from './runtime'

/** Swallows a promise's eventual rejection, for promises nothing will ever await again. */
export function suppress(promise: Promise<unknown>): void {
  promise.catch(() => undefined)
}

/**
 * How `raceWithAbort` reports that the signal won. Internal: the state machine catches it
 * and mints the public `ABORTED` error with whatever attempts the run has.
 */
export class AbortRaceLost extends Error {
  constructor() {
    super('the abort signal won the race')
    this.name = 'AbortRaceLost'
  }
}

/**
 * How a deadline race reports that the timer won. Internal: the caller chains it as the
 * `cause` of the store-unavailable error it mints.
 */
export class DeadlineExceeded extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not settle within its ${String(ms)} ms deadline`)
    this.name = 'DeadlineExceeded'
  }
}

/**
 * Races an awaited user callback against the caller's signal (spec §1).
 *
 * On abort the core stops waiting and the race rejects with `AbortRaceLost`; the loser keeps
 * a reaction attached, so its eventual rejection stays silent. The listener is removed as
 * soon as the callback settles, so listeners stay balanced however the race ends.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    suppress(promise)
    return Promise.reject(new AbortRaceLost())
  }
  let rejectLost: ((error: Error) => void) | undefined
  const lost = new Promise<never>((_resolve, reject) => {
    rejectLost = reject
  })
  const onAbort = (): void => {
    rejectLost?.(new AbortRaceLost())
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const settled = promise.finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
  return Promise.race([settled, lost])
}

/**
 * Bounds one store call with its §6a deadline, the timer starting when the call is issued.
 *
 * The call is invoked inside the helper so a synchronous throw becomes a rejection, and the
 * timer is cancelled the moment the call settles; on timeout the race rejects with
 * `DeadlineExceeded` while the still-pending call keeps its silent reaction.
 */
export function callWithDeadline<T>(
  runtime: CoreRuntime,
  ms: number,
  what: string,
  mode: TimerMode,
  call: () => PromiseLike<T> | T,
): Promise<T> {
  const promise = (async () => await call())()
  let handle: unknown
  const expired = new Promise<never>((_resolve, reject) => {
    handle = runtime.schedule(
      () => {
        reject(new DeadlineExceeded(what, ms))
      },
      ms,
      mode,
    )
  })
  const settled = promise.finally(() => {
    runtime.cancel(handle)
  })
  return Promise.race([settled, expired])
}

/**
 * Waits out a backoff delay unless the signal fires first.
 *
 * Used between commit retries: the §1 rule checks the signal before every quota-recovery
 * I/O, and ending the wait early just reports the abort sooner, and the check still guards the
 * I/O itself. The timer is referenced (an in-flight run may not let the process exit) and is
 * cancelled if the abort wins; the listener is removed if the delay elapses.
 */
export function sleepUnlessAborted(
  runtime: CoreRuntime,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<'elapsed' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve('aborted')
      return
    }
    const onAbort = (): void => {
      runtime.cancel(handle)
      resolve('aborted')
    }
    const handle = runtime.schedule(
      () => {
        signal?.removeEventListener('abort', onAbort)
        resolve('elapsed')
      },
      ms,
      'referenced',
    )
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
