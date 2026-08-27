/**
 * Deciding whether a `DATABASE_URL` is one a destructive check may be pointed at.
 *
 * A release check creates a schema, truncates tables and drops the schema again. None of that
 * is safe anywhere but a throwaway database on the machine running it, so the rule is a
 * whitelist of one shape — `postgres://user:password@127.0.0.1:port/database` — rather than a
 * blacklist of anything else.
 *
 * The subtlety is that a connection string's authority is not necessarily where the driver
 * connects. libpq-style parameters — `?host=`, `?hostaddr=`, `?port=` — override it, so
 * `postgres://user@127.0.0.1/db?host=elsewhere.example` reads as loopback and connects to
 * `elsewhere.example`. Reading `new URL(...).hostname` therefore answers the wrong question.
 * What is checked here is the target the driver would actually resolve, taken from the same
 * parser the driver itself uses.
 *
 * Three further rules follow from the same thought — that nothing outside the string should
 * get to choose where the connection goes:
 *
 * - `?` and `#` are refused wherever they appear in the raw string, not merely where a parser
 *   found a query. A verification run has no need of a parameter, and refusing the whole class
 *   is worth more than keeping up with which of them can redirect a connection.
 * - The port must be written down. Left out, it comes from the operator's `PGPORT`, and a
 *   check that says which machine it will write to but not which server is only half a rule.
 * - Only IPv4 loopback. `::1` is not offered at all; `isLoopbackAddress` says why.
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

/**
 * Whether a host is written as a loopback address.
 *
 * The whole of `127.0.0.0/8`, and nothing else. A name is never accepted, not even
 * `localhost`: what a name resolves to is decided by files and servers this check does not
 * control, and a run that writes to somebody else's database has already done the damage by
 * the time the mistake is visible.
 *
 * `::1` is not accepted either, which is a narrower rule than it looks. The connection string
 * parser hands back an IPv6 host with its brackets still on — `[::1]` — and the driver passes
 * that string to `net.connect` as a host, where it is not an address literal at all but a name
 * to be resolved (it fails with ENOTFOUND). So the IPv6 spelling never reached a loopback
 * socket in the first place, and accepting it would have meant accepting a name lookup, which
 * is the one thing this guard exists to refuse. IPv4 loopback is what works, so IPv4 loopback
 * is what is offered.
 *
 * @param {string} host The host as the connection string gives it.
 * @returns {boolean} Whether it is a literal IPv4 loopback address.
 */
export function isLoopbackAddress(host) {
  const octets = ipv4Octets(host)
  return octets !== null && octets[0] === 127
}

/** The one shape this check accepts, quoted back to the operator by every rejection. */
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
      '127.0.0.0/8. A host name is refused even when it is spelt localhost, because what a ' +
      `name resolves to is not this check to decide. Give it ${WANTED}`
    )
  }

  // Read off the raw string rather than off anything parsed. A `#` makes everything after it a
  // fragment, so `…/db#?host=evil` leaves the parsed query empty while still being a string
  // nobody meant to hand a destructive check; a bare `?` does the same with nothing after it.
  // Neither belongs in a connection string for this, so the character is refused wherever it
  // appears rather than only where a parser happened to look.
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
