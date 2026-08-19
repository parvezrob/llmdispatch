/**
 * The UTC day arithmetic every store shares.
 *
 * The day a slot is counted against is the store's, not the caller's (spec §4), so both
 * stores derive it the same way from the same instant.
 *
 * @module
 */

const DAY_MS = 86_400_000

/** The UTC calendar day an instant falls on, as `YYYY-MM-DD`. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

/** When a day's allowance resets: the UTC midnight that ends it, as an ISO instant. */
export function resetsAt(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString()
}
