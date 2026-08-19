/**
 * The clock an internal store factory runs on, and the one rule it enforces.
 *
 * A pinned clock never moves backwards: the reservation fence (spec §4) reads "already
 * expired" off it, and an answer that flipped back would stop being final.
 *
 * @module
 */

/** A store's clock, as its factory and its `setTime` control share it. */
export interface StoreClock {
  /** The instant to use, or `null` when nothing has been pinned and no clock was supplied. */
  at: () => Date | null
  setTime: (date: Date) => void
  unpin: () => void
}

/**
 * Builds a store clock.
 *
 * @param now The clock the factory was given, if any.
 * @throws `RangeError` from `setTime` for an invalid date or one before the pinned instant.
 */
export function createStoreClock(now: (() => Date) | undefined): StoreClock {
  let pinned: number | null = null
  return {
    at: () => (pinned === null ? (now?.() ?? null) : new Date(pinned)),
    setTime(date) {
      const at = date.getTime()
      if (Number.isNaN(at)) throw new RangeError('setTime needs a valid date')
      if (pinned !== null && at < pinned) {
        throw new RangeError('setTime must not move the store clock backwards before reset')
      }
      pinned = at
    },
    unpin() {
      pinned = null
    },
  }
}
