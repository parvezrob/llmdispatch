/**
 * The real runtime behind the core's clock-and-timer seam, built from `globalThis`.
 *
 * The globals are read at call time, not import time, and `.unref()` is called only where the
 * returned handle actually has one — Node handles do, browser and edge runtimes hand back
 * numbers — so the same build runs anywhere `setTimeout` exists.
 *
 * @module
 */

import type { CoreRuntime } from './core/runtime'

/** The least the host must provide; typed structurally so no platform lib is assumed. */
interface TimerGlobals {
  setTimeout(handler: () => void, timeout?: number): unknown
  clearTimeout(handle: unknown): void
}

/** Whether a timer handle can be told not to hold the process open. */
function hasUnref(handle: unknown): handle is { unref(): unknown } {
  return (
    typeof handle === 'object' &&
    handle !== null &&
    typeof (handle as { unref?: unknown }).unref === 'function'
  )
}

/** Builds the runtime the root entry hands to the core. */
export function createGlobalRuntime(): CoreRuntime {
  return {
    now: () => Date.now(),
    schedule(callback, delayMs, mode) {
      const timers = globalThis as unknown as TimerGlobals
      const handle = timers.setTimeout(callback, delayMs)
      if (mode === 'unreferenced' && hasUnref(handle)) handle.unref()
      return handle
    },
    cancel(handle) {
      const timers = globalThis as unknown as TimerGlobals
      timers.clearTimeout(handle)
    },
  }
}
