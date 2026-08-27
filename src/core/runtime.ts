/**
 * The clock and timer seam the core runs on.
 *
 * The core never reads a clock or schedules a timer itself (see this folder's README): it is
 * handed this object, the root entry wires the real one from `globalThis`, and tests inject a
 * fake. The referenced/unreferenced distinction is the process-liveness contract: a referenced
 * timer may keep the process alive (store deadlines, provider timeouts, the awaited settle),
 * an unreferenced one must not (the detached settlement retries: spec §4 lets the process
 * exit before them, losing attempt records but never slot accounting).
 *
 * @module
 */

/** Whether a pending timer may hold the process open. */
export type TimerMode = 'referenced' | 'unreferenced'

/** What the core is handed instead of `Date.now` and `setTimeout`. Internal, not published. */
export interface CoreRuntime {
  /** The current time in milliseconds; only ever compared, never interpreted as wall time. */
  now(): number
  /** Schedules `callback` after `delayMs`; the returned handle is opaque to the core. */
  schedule(callback: () => void, delayMs: number, mode: TimerMode): unknown
  /** Cancels a handle from `schedule`. Cancelling one that already fired does nothing. */
  cancel(handle: unknown): void
}
