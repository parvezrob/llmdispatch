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
    expect(describeUnusableDatabase('postgres://user@127.0.0.2/db')).toBeNull()
    expect(describeUnusableDatabase('postgres://user@127.15.200.9/db')).toBeNull()
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.255.255.254')).toBe(true)
    expect(isLoopbackAddress('128.0.0.1')).toBe(false)
    expect(isLoopbackAddress('126.255.255.255')).toBe(false)
  })

  it('accepts the IPv6 loopback however it is spelt', () => {
    expect(describeUnusableDatabase('postgres://user@[::1]:5432/db')).toBeNull()
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('[::1]')).toBe(true)
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isLoopbackAddress('::2')).toBe(false)
    expect(isLoopbackAddress('::')).toBe(false)
  })

  it('rejects a host parameter that moves the connection off this machine', () => {
    // The authority reads as loopback and the driver connects to the other host. This is the
    // case the guard exists for.
    expect(describeUnusableDatabase('postgres://user@127.0.0.1/db?host=example.com')).toMatch(
      /connects to 'example.com'/,
    )
  })

  it('rejects a hostaddr parameter, which decides the address on its own', () => {
    expect(
      describeUnusableDatabase('postgres://user@127.0.0.1/db?hostaddr=203.0.113.7'),
    ).toMatch(/hostaddr/)
  })

  it('rejects any query string at all, even a harmless-looking one', () => {
    expect(describeUnusableDatabase('postgres://user@127.0.0.1/db?sslmode=disable')).toMatch(
      /query parameters/,
    )
    expect(describeUnusableDatabase('postgres://user@127.0.0.1/db?port=6000')).toMatch(
      /query parameters/,
    )
  })

  it('rejects a host name, including localhost', () => {
    // Whether `localhost` is 127.0.0.1 is decided by a hosts file and a resolver, neither of
    // which this check controls.
    expect(describeUnusableDatabase('postgres://user@localhost/db')).toMatch(
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
