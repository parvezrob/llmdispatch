/**
 * Deciding whether a `DATABASE_URL` is one a destructive check may be pointed at.
 *
 * A release check creates a schema, truncates tables and drops the schema again. None of that
 * is safe anywhere but a throwaway database on the machine running it, so the rule is a
 * whitelist of literal loopback addresses rather than a blacklist of anything else.
 *
 * The subtlety is that a connection string's authority is not necessarily where the driver
 * connects. libpq-style parameters — `?host=`, `?hostaddr=`, `?port=` — override it, so
 * `postgres://user@127.0.0.1/db?host=elsewhere.example` reads as loopback and connects to
 * `elsewhere.example`. Reading `new URL(...).hostname` therefore answers the wrong question.
 * What is checked here is the target the driver would actually resolve, taken from the same
 * parser the driver itself uses, and any query string at all is refused on top of that: a
 * verification run has no need of one, and refusing the whole class is worth more than
 * keeping up with which parameters can redirect a connection.
 *
 * @module
 */

import { parse } from 'pg-connection-string'

/** Every octet of a dotted-quad, or `null` when it is not one. */
function ipv4Octets(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return null
  const parts = match.slice(1)
  // A leading zero makes an octet ambiguous (some resolvers read it as octal), and an
  // out-of-range one is not an address at all. Neither is something to guess about.
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return null
  const octets = parts.map((part) => Number(part))
  return octets.every((octet) => octet <= 255) ? octets : null
}

/** The eight groups of an IPv6 address, `::` expanded, or `null` when it is not one. */
function ipv6Groups(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (!/^[0-9A-Fa-f:]+$/.test(bare)) return null
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const read = (text) => (text === '' ? [] : text.split(':'))
  const head = read(halves[0] ?? '')
  const tail = halves.length === 2 ? read(halves[1] ?? '') : []
  const filled = 8 - head.length - tail.length
  if (halves.length === 2 && filled < 0) return null
  const groups =
    halves.length === 2
      ? [...head, ...Array.from({ length: filled }, () => '0'), ...tail]
      : head
  if (groups.length !== 8 || groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) {
    return null
  }
  return groups.map((group) => Number.parseInt(group, 16))
}

/**
 * Whether a host is written as a loopback address.
 *
 * The whole of `127.0.0.0/8` and `::1` in any of its spellings. A name is never accepted, not
 * even `localhost`: what a name resolves to is decided by files and servers this check does
 * not control, and a run that writes to somebody else's database has already done the damage
 * by the time the mistake is visible.
 *
 * @param {string} host The host as the connection string gives it.
 * @returns {boolean} Whether it is a literal loopback address.
 */
export function isLoopbackAddress(host) {
  const octets = ipv4Octets(host)
  if (octets !== null) return octets[0] === 127
  const groups = ipv6Groups(host)
  if (groups === null) return false
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
}

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

  // `hostaddr` bypasses the host entirely: the driver connects to that address and keeps the
  // host name only for authentication. There is no reading of it that this check wants.
  if ((target.hostaddr ?? '') !== '') {
    return 'DATABASE_URL sets hostaddr, which decides where the connection actually goes'
  }

  const host = target.host ?? ''
  if (host === '') return 'DATABASE_URL names no host'
  if (!isLoopbackAddress(host)) {
    return (
      `DATABASE_URL connects to '${host}'. This check creates and drops schemas and truncates ` +
      'tables, so it only runs against a throwaway database on this machine: an address in ' +
      '127.0.0.0/8, or ::1. A host name is refused even when it is spelt localhost, because ' +
      'what a name resolves to is not this check to decide'
    )
  }

  if (parsed.search !== '') {
    return (
      'DATABASE_URL carries query parameters. Several of them move the connection somewhere ' +
      'else, so a destructive check refuses all of them: give it a bare ' +
      'postgres://user:password@127.0.0.1:port/database'
    )
  }
  return null
}
