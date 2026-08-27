import { describe, expect, it } from 'vitest'

import {
  describeUnusableDatabase,
  isLoopbackAddress,
} from '../../../scripts/lib/database-target.mjs'

/**
 * The guard in front of a destructive check. Everything below is about one question: does the
 * connection go somewhere this machine can afford to have schemas created and dropped in.
 */
describe('the database target guard', () => {
  it('accepts a bare loopback connection string', () => {
    expect(describeUnusableDatabase('postgres://user:pw@127.0.0.1:5433/postgres')).toBeNull()
  })

  it('accepts any address in 127.0.0.0/8', () => {
    expect(describeUnusableDatabase('postgres://user@127.0.0.2:5433/db')).toBeNull()
    expect(describeUnusableDatabase('postgres://user@127.15.200.9:5432/db')).toBeNull()
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.255.255.254')).toBe(true)
    expect(isLoopbackAddress('128.0.0.1')).toBe(false)
    expect(isLoopbackAddress('126.255.255.255')).toBe(false)
  })

  it('rejects the IPv6 loopback, which the driver would resolve as a name', () => {
    // The parser hands back `[::1]`, brackets and all, and the driver gives that to
    // `net.connect` as a host — where it is a name to look up, not an address. Offering it
    // would have meant offering a name lookup, which is the one thing this guard refuses.
    expect(describeUnusableDatabase('postgres://user@[::1]:5432/db')).toMatch(/connects to/)
    expect(isLoopbackAddress('::1')).toBe(false)
    expect(isLoopbackAddress('[::1]')).toBe(false)
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(false)
  })

  it('rejects a connection string with no port, which PGPORT would then choose', () => {
    expect(describeUnusableDatabase('postgres://user@127.0.0.1/db')).toMatch(/names no port/)
    expect(describeUnusableDatabase('postgres://user:pw@127.0.0.1/postgres')).toMatch(
      /postgres:\/\/user:password@127\.0\.0\.1:port\/database/,
    )
  })

  it('rejects a host parameter that moves the connection off this machine', () => {
    // The authority reads as loopback and the driver connects to the other host. This is the
    // case the guard exists for, so it is named as the target rather than as a stray `?`.
    expect(
      describeUnusableDatabase('postgres://user@127.0.0.1:5433/db?host=example.com'),
    ).toMatch(/connects to 'example.com'/)
  })

  it('rejects a hostaddr parameter, which decides the address on its own', () => {
    expect(
      describeUnusableDatabase('postgres://user@127.0.0.1:5433/db?hostaddr=203.0.113.7'),
    ).toMatch(/hostaddr/)
  })

  it('rejects any query string at all, even a harmless-looking one', () => {
    expect(
      describeUnusableDatabase('postgres://user@127.0.0.1:5433/db?sslmode=disable'),
    ).toMatch(/'\?' or '#'/)
    expect(describeUnusableDatabase('postgres://user@127.0.0.1:5433/db?port=6000')).toMatch(
      /'\?' or '#'/,
    )
  })

  it("rejects a bare '?' and a fragment, which a parser reads as no query at all", () => {
    // `new URL(...).search` is empty for both of these, so a check that trusted the parsed
    // query would let them through.
    expect(describeUnusableDatabase('postgres://user@127.0.0.1:5433/db?')).toMatch(
      /'\?' or '#'/,
    )
    expect(describeUnusableDatabase('postgres://user@127.0.0.1:5433/db#?host=evil')).toMatch(
      /'\?' or '#'/,
    )
  })

  it('rejects a host name, including localhost', () => {
    // Whether `localhost` is 127.0.0.1 is decided by a hosts file and a resolver, neither of
    // which this check controls.
    expect(describeUnusableDatabase('postgres://user@localhost:5433/db')).toMatch(
      /connects to 'localhost'/,
    )
    expect(describeUnusableDatabase('postgres://user@example.com:5432/db')).toMatch(
      /connects to 'example.com'/,
    )
    expect(isLoopbackAddress('localhost')).toBe(false)
  })

  it('rejects what is not a connection string, and one that names no host', () => {
    expect(describeUnusableDatabase('')).toBe('DATABASE_URL is not a URL')
    expect(describeUnusableDatabase('not a url')).toBe('DATABASE_URL is not a URL')
    expect(describeUnusableDatabase('postgres:///db')).toBe('DATABASE_URL names no host')
  })
})
