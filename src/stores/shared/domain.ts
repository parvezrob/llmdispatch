/**
 * The domain every string a store persists has to be in (spec §6, "String domain").
 *
 * A relational store cannot hold every JavaScript string, so the contract bounds them and
 * both stores refuse the same values rather than silently altering them.
 *
 * @module
 */

/** The contract's bound: 1 000 bytes of UTF-8. */
const MAX_BYTES = 1000

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
