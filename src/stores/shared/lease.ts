/**
 * The reservation lease both stores accept, and the rule that keeps them accepting the same one.
 *
 * @module
 */

/** The lease a public factory uses when the adopter names none (spec §6). */
export const DEFAULT_LEASE_MS = 120_000

const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 600_000

/**
 * Checks a lease every store can work with, naming the option in the message.
 *
 * @param leaseMs The lease as the caller supplied it.
 * @throws `RangeError` when it is not a safe integer between 5 000 and 600 000.
 */
export function assertLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new RangeError(
      `leaseMs must be a safe integer between ${String(MIN_LEASE_MS)} and ${String(MAX_LEASE_MS)}`,
    )
  }
}
