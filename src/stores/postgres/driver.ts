/**
 * The driver seam: the slice of a pool the stores use, and how its answers are read.
 *
 * The pool contract hands back `unknown`, and a store that guessed would turn a schema that is
 * not the one it migrated into wrong numbers rather than a loud failure. So every value is
 * checked on the way in, down to whether a day is a day: the store refuses to report anything
 * it cannot vouch for.
 *
 * @module
 */

import { isStoreDay, isStoreString } from '../shared/domain'

/**
 * What a store needs from a connection pool (spec §6).
 *
 * A `pg.Pool` satisfies it as it stands; so does anything else that runs one statement and
 * hands back its rows. Each call is its own transaction, which is why every statement the
 * stores send is a single command.
 */
export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

/** A row as a driver returned it, once it is known to be an object at all. */
export type Row = Record<string, unknown>

/** Every problem here is the same one: what came back is not what the statement selects. */
export function malformed(what: string): never {
  throw new TypeError(`the store received ${what}; the schema is not the one it migrated`)
}

/**
 * The rows of a result, once the result itself is known to hold any.
 *
 * @throws `TypeError` when the result is not an object with rows of its own.
 */
export function resultRows(result: unknown): unknown[] {
  if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'rows')) {
    malformed('a result with no rows of its own')
  }
  const rows: unknown = (result as Row).rows
  if (!Array.isArray(rows)) malformed('a result whose rows are not an array')
  return rows
}

/** An entry of a result, once it is known to be a row. */
function asRow(row: unknown): Row {
  if (typeof row !== 'object' || row === null) malformed('a result row that is not an object')
  return row as Row
}

/**
 * The one row a statement is written to return.
 *
 * @throws `TypeError` when the result holds no row, more than one, or one that is not an object.
 */
export function singleRow(rows: unknown[]): Row {
  if (rows.length === 0) malformed('no row where a statement returns one')
  if (rows.length > 1) malformed('several rows where a statement returns one')
  return asRow(rows[0])
}

/**
 * The row a statement returns at most one of.
 *
 * @throws `TypeError` when the result holds more than one row, or one that is not an object.
 */
export function optionalRow(rows: unknown[]): Row | null {
  if (rows.length === 0) return null
  if (rows.length > 1) malformed('several rows where a statement returns at most one')
  return asRow(rows[0])
}

/**
 * Every row of a result, each known to be an object.
 *
 * @throws `TypeError` when one of them is not an object.
 */
export function objectRows(rows: unknown[]): Row[] {
  return rows.map(asRow)
}

/**
 * The value of a column the statement selects, whatever type it holds.
 *
 * A column the row does not carry, or carries as `undefined`, is the clearest sign of a
 * foreign schema: a driver reports SQL NULL as `null`, never as a missing value.
 *
 * @throws `TypeError` when the row has no such column of its own, or it is `undefined`.
 */
export function readColumn(row: Row, name: string): unknown {
  if (!Object.hasOwn(row, name)) malformed(`a result row with no "${name}" column`)
  const value = row[name]
  if (value === undefined) malformed(`an undefined "${name}"`)
  return value
}

/**
 * A column that must hold text.
 *
 * @throws `TypeError` when it is missing or holds anything else.
 */
export function readString(row: Row, name: string): string {
  const value = readColumn(row, name)
  if (typeof value !== 'string') malformed(`a non-text "${name}"`)
  return value
}

/**
 * A column that holds text or SQL NULL.
 *
 * @throws `TypeError` when it is missing or holds anything else.
 */
export function readOptionalString(row: Row, name: string): string | null {
  const value = readColumn(row, name)
  if (value === null) return null
  if (typeof value !== 'string') malformed(`a non-text "${name}"`)
  return value
}

/**
 * A column holding a string this store could have persisted (spec §6).
 *
 * @throws `TypeError` when it is missing, is not text, or is outside the string domain.
 */
export function readStoreString(row: Row, name: string): string {
  const value = readString(row, name)
  if (!isStoreString(value)) malformed(`a "${name}" no store could have written`)
  return value
}

/**
 * A column holding a UTC calendar day.
 *
 * @throws `TypeError` when it is missing, is not text, or is not a canonical day.
 */
export function readDay(row: Row, name: string): string {
  const value = readString(row, name)
  if (!isStoreDay(value)) malformed(`a "${name}" that is not a UTC calendar day`)
  return value
}

/**
 * A column holding an instant, as the statements format them.
 *
 * @throws `TypeError` when it is missing, is not text, or is not a readable instant.
 */
export function readInstant(row: Row, name: string): string {
  const value = readString(row, name)
  if (Number.isNaN(Date.parse(value))) malformed(`a "${name}" that is not an instant`)
  return value
}

/**
 * A column holding an instant or SQL NULL.
 *
 * @throws `TypeError` when it is missing, is not text, or is not a readable instant.
 */
export function readOptionalInstant(row: Row, name: string): string | null {
  const value = readOptionalString(row, name)
  if (value === null) return null
  if (Number.isNaN(Date.parse(value))) malformed(`a "${name}" that is not an instant`)
  return value
}

/**
 * A column holding a reservation id: non-empty, and one a store could have issued.
 *
 * The schema's own `CHECK` says an id is never empty and the string domain says what a store
 * may hold, so an id failing either is one this store cannot have issued.
 *
 * @throws `TypeError` when it is missing, is not text, is empty, or is outside the domain.
 */
export function readReservationId(row: Row, name: string): string {
  const value = readString(row, name)
  if (value === '' || !isStoreString(value)) {
    malformed(`a "${name}" no store could have issued`)
  }
  return value
}

/**
 * A column holding a reservation id or SQL NULL.
 *
 * @throws `TypeError` when it is missing, is not text, is empty, or is outside the domain.
 */
export function readOptionalReservationId(row: Row, name: string): string | null {
  const value = readOptionalString(row, name)
  if (value === null) return null
  if (value === '' || !isStoreString(value)) {
    malformed(`a "${name}" no store could have issued`)
  }
  return value
}

/**
 * A column that must hold a count: every whole number these statements report is one.
 *
 * @throws `TypeError` when it is missing, is not a whole number, or is negative.
 */
export function readInteger(row: Row, name: string): number {
  const value = readColumn(row, name)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`a "${name}" that is not a count`)
  }
  return value
}

/**
 * A column that must hold a boolean.
 *
 * @throws `TypeError` when it is missing or holds anything else.
 */
export function readBoolean(row: Row, name: string): boolean {
  const value = readColumn(row, name)
  if (typeof value !== 'boolean') malformed(`a non-boolean "${name}"`)
  return value
}
