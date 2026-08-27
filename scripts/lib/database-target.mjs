/**
 * Guard for the `DATABASE_URL` of a destructive release check, which creates schemas,
 * truncates tables and drops schemas.
 *
 * Accepts one shape only: `postgres://user:password@127.0.0.1:port/database`. The target is
 * resolved with the driver's own parser because libpq-style parameters (`?host=`,
 * `?hostaddr=`, `?port=`) override the URL authority.
 *
 * @module
 */

import { parse } from 'pg-connection-string'

/** Every octet of a dotted-quad, or `null` when it is not one. */
function ipv4Octets(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return null
  const parts = match.slice(1)
  // A leading zero is ambiguous: some resolvers read it as octal.
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return null
  const octets = parts.map((part) => Number(part))
  return octets.every((octet) => octet <= 255) ? octets : null
}

/**
 * Whether a host is a literal address in `127.0.0.0/8`.
 *
 * Names are never accepted, `localhost` included: this check does not control what a name
 * resolves to. `::1` is not accepted either: the parser returns it bracketed as `[::1]`, and
 * the driver passes that to `net.connect` as a name to resolve, which fails with ENOTFOUND.
 *
 * @param {string} host The host as the connection string gives it.
 * @returns {boolean} Whether it is a literal IPv4 loopback address.
 */
export function isLoopbackAddress(host) {
  const octets = ipv4Octets(host)
  return octets !== null && octets[0] === 127
}

/** The accepted shape, quoted back by every rejection. */
const WANTED = 'a bare postgres://user:password@127.0.0.1:port/database'

/**
 * Why this database may not be used, or `null` when it may.
 *
 * @param {string} url The value of `DATABASE_URL`.
 * @returns {string | null} A sentence naming the problem, or `null`.
 */
export function describeUnusableDatabase(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'DATABASE_URL is not a URL'
  }

  let target
  try {
    target = parse(url)
  } catch {
    return 'DATABASE_URL is not a connection string the driver can read'
  }

  // `hostaddr` bypasses the host: the driver connects there and keeps the host name only for
  // authentication.
  if ((target.hostaddr ?? '') !== '') {
    return 'DATABASE_URL sets hostaddr, which decides where the connection actually goes'
  }

  const host = target.host ?? ''
  if (host === '') return 'DATABASE_URL names no host'
  if (!isLoopbackAddress(host)) {
    return (
      `DATABASE_URL connects to '${host}'. This check creates and drops schemas and truncates ` +
      'tables, so it only runs against a throwaway database on this machine: an address in ' +
      '127.0.0.0/8. A host name is refused even when it is spelt localhost, because what a ' +
      `name resolves to is not this check to decide. Give it ${WANTED}`
    )
  }

  // Checked on the raw string: a `#` makes the rest a fragment, so `…/db#?host=evil` parses
  // to an empty query.
  if (url.includes('?') || url.includes('#')) {
    return (
      "DATABASE_URL contains '?' or '#'. Several query parameters move the connection " +
      'somewhere else and a fragment hides them from a parser, so a destructive check refuses ' +
      `both outright: give it ${WANTED}`
    )
  }

  if (parsed.port === '') {
    return (
      'DATABASE_URL names no port. Without one the port is whatever PGPORT happens to say, ' +
      `which is not this check to decide either: give it ${WANTED}`
    )
  }
  return null
}
