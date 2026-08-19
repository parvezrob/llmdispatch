import { describe, expect, it } from 'vitest'

import { runConfigStoreConformance, runUsageStoreConformance } from '../../../src/conformance'
import { deepEqual } from '../../../src/conformance/result'
import { createMemoryStores } from '../../../src/stores/memory'
import type { OperationRoute, QuotaKey, UsageStore } from '../../../src/types'

/** Every usage case, in the order the suite always runs them. */
const USAGE_CASES = [
  'reserve-atomicity',
  'reservation-ids-globally-unique',
  'commit-idempotent',
  'commit-lost-ack-retry',
  'commit-unknown-missing',
  'commit-lapsed-expired',
  'commit-reclaimed-expired',
  'settle-idempotent',
  'settle-duplicate-conflict-first-write-wins',
  'settle-known-pending',
  'settle-known-committed',
  'settle-known-expired',
  'settle-unknown-accounting',
  'settle-unknown-recorded',
  'settle-round-trip',
  'lease-expiry-frees-pending',
  'lease-never-frees-committed',
  'lease-capped-at-day-boundary',
  'day-rollover',
  'snapshot-includes-pending',
  'envelope-key-matches',
  'envelope-day-format',
  'reserve-limit-zero-consumes-nothing',
  'limit-lowered-below-usage-denies',
  'returned-values-detached',
  'rejects-out-of-domain-strings',
]

/** Every config case, in the order the suite always runs them. */
const CONFIG_CASES = [
  'set-get-round-trip',
  'delete-removes-row',
  'seed-raw-returned-verbatim',
  'read-your-writes',
  'quota-field-verbatim',
  'special-operation-names',
  'long-operation-names-distinct',
  'returned-values-detached',
  'rejects-out-of-domain-strings',
]

/** The case each failure came from. */
function cases(failures: string[]): string[] {
  return failures.map((failure) => failure.slice(0, failure.indexOf(':')))
}

/** The memory pair, wired up the way an adopter wires their own store. */
function usageUnderTest(store?: UsageStore) {
  const memory = createMemoryStores({})
  return {
    create: () =>
      Promise.resolve({
        store: store ?? memory.stores.usage,
        setTime: memory.controls.setTime,
        reset: memory.controls.reset,
        readSettled: memory.controls.readSettled,
      }),
    memory,
  }
}

describe('the usage store suite', () => {
  it('passes against the in-memory store', async () => {
    const result = await runUsageStoreConformance(usageUnderTest())

    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('runs every documented case, in order, and reports each one that fails', async () => {
    const rejecting: UsageStore = {
      reserve: () => Promise.reject(new Error('store offline')),
      commit: () => Promise.reject(new Error('store offline')),
      settle: () => Promise.reject(new Error('store offline')),
      snapshot: () => Promise.reject(new Error('store offline')),
    }

    const result = await runUsageStoreConformance(usageUnderTest(rejecting))

    expect(result.passed).toBe(false)
    expect(cases(result.failures)).toEqual(USAGE_CASES)
    expect(result.skipped).toEqual([])
  })

  it('fails the named case when a store treats a zero limit as no limit', async () => {
    const { create, memory } = usageUnderTest()
    const broken: UsageStore = {
      ...memory.stores.usage,
      reserve: (key, limit) => memory.stores.usage.reserve(key, limit === 0 ? 1 : limit),
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect([...new Set(cases(result.failures))]).toEqual([
      'reserve-limit-zero-consumes-nothing',
    ])
    expect(result.failures[0]).toContain('to be denied but it was admitted')
  })

  it('fails the named case when a commit is not idempotent', async () => {
    const { create, memory } = usageUnderTest()
    const seen = new Set<string>()
    const broken: UsageStore = {
      ...memory.stores.usage,
      commit: async (reservationId) => {
        const answer = await memory.stores.usage.commit(reservationId)
        if (answer !== 'committed') return answer
        if (seen.has(reservationId)) return 'expired'
        seen.add(reservationId)
        return answer
      },
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect(cases(result.failures)).toContain('commit-idempotent')
    expect(result.failures).toContainEqual(
      "commit-idempotent: the second commit to be 'committed' but it was 'expired'",
    )
  })

  it('starts every case from a reset store and a clock that never moves backwards', async () => {
    const memory = createMemoryStores({})
    const segments: number[][] = []
    const result = await runUsageStoreConformance({
      create: () =>
        Promise.resolve({
          store: memory.stores.usage,
          reset: () => {
            segments.push([])
            return memory.controls.reset()
          },
          setTime: (date: Date) => {
            segments.at(-1)?.push(date.getTime())
            return memory.controls.setTime(date)
          },
          readSettled: memory.controls.readSettled,
        }),
    })

    expect(result.passed).toBe(true)
    // One reset for the lease check that runs first, then one before every case.
    expect(segments).toHaveLength(USAGE_CASES.length + 1)
    for (const instants of segments) {
      expect(instants).toEqual([...instants].sort((left, right) => left - right))
    }
  })

  it('keeps going after a failure, from a store that was reset first', async () => {
    const { create, memory } = usageUnderTest()
    const broken: UsageStore = {
      ...memory.stores.usage,
      // Only the case that reserves at a limit of three is broken; the rest are untouched, so
      // a run that reports nothing else also shows they each started from a reset store.
      reserve: (key, limit) => memory.stores.usage.reserve(key, limit === 3 ? 2 : limit),
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect([...new Set(cases(result.failures))]).toEqual(['reserve-atomicity'])
  })

  it('stops with one failure when the lease is outside the window the cases need', async () => {
    const start = Date.parse('2026-01-15T12:00:00.000Z')
    const leases = [start + 50, Date.parse('2026-01-16T00:00:00.000Z')]

    for (const endsAt of leases) {
      const { create, memory } = usageUnderTest()
      const broken: UsageStore = {
        ...memory.stores.usage,
        reserve: async (key, limit) => {
          const result = await memory.stores.usage.reserve(key, limit)
          return result.ok ? { ...result, expiresAt: new Date(endsAt).toISOString() } : result
        },
      }

      const result = await runUsageStoreConformance({
        create: () => create().then((controls) => ({ ...controls, store: broken })),
      })

      expect(result.failures).toHaveLength(1)
      expect(cases(result.failures)).toEqual(['lease-window'])
    }
  })

  it('fails the named case when every envelope shares one key object', async () => {
    const { create, memory } = usageUnderTest()
    const shared = { operation: '', subjectId: '' }
    const broken: UsageStore = {
      ...memory.stores.usage,
      reserve: async (key, limit) => {
        const result = await memory.stores.usage.reserve(key, limit)
        if (!result.ok) return result
        shared.operation = key.operation
        shared.subjectId = key.subjectId
        return { ...result, reservation: { ...result.reservation, key: shared } }
      },
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect(cases(result.failures)).toContain('reservation-ids-globally-unique')
  })

  it('fails the named case when a lease survives the day it was capped at', async () => {
    const { create, memory } = usageUnderTest()
    const broken: UsageStore = {
      ...memory.stores.usage,
      commit: async (reservationId) => {
        const answer = await memory.stores.usage.commit(reservationId)
        return answer === 'expired' ? 'committed' : answer
      },
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect(cases(result.failures)).toContain('lease-capped-at-day-boundary')
  })

  it('fails the named cases when settling quietly hands a slot back', async () => {
    const { create, memory } = usageUnderTest()
    let settled = false
    const broken: UsageStore = {
      ...memory.stores.usage,
      settle: async (envelope, outcome, attempts) => {
        settled = true
        await memory.stores.usage.settle(envelope, outcome, attempts)
      },
      reserve: (key, limit) => memory.stores.usage.reserve(key, settled ? limit + 1 : limit),
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect(cases(result.failures)).toContain('settle-known-expired')
    expect(cases(result.failures)).toContain('settle-unknown-accounting')
  })

  it('fails the named case when a store repairs a key it cannot hold', async () => {
    const { create, memory } = usageUnderTest()
    const broken: UsageStore = {
      ...memory.stores.usage,
      reserve: (key, limit) =>
        memory.stores.usage.reserve(
          {
            operation: key.operation.replaceAll('\u0000', ''),
            subjectId: key.subjectId.replaceAll('\u0000', ''),
          },
          limit,
        ),
    }

    const result = await runUsageStoreConformance({
      create: () => create().then((controls) => ({ ...controls, store: broken })),
    })

    expect(cases(result.failures)).toContain('rejects-out-of-domain-strings')
  })

  it('reports a create that throws and runs nothing', async () => {
    const result = await runUsageStoreConformance({
      create: () => Promise.reject(new Error('no database')),
    })

    expect(result).toEqual({
      passed: false,
      failures: ['create: no database'],
      skipped: [],
    })
  })

  it('reports a reset that throws once per case and still finishes the run', async () => {
    const memory = createMemoryStores({})
    const result = await runUsageStoreConformance({
      create: () =>
        Promise.resolve({
          store: memory.stores.usage,
          setTime: memory.controls.setTime,
          reset: () => Promise.reject(new Error('truncate failed')),
          readSettled: memory.controls.readSettled,
        }),
    })

    expect(result.failures).toHaveLength(USAGE_CASES.length)
    expect(result.failures[0]).toBe('reserve-atomicity: reset failed: Error: truncate failed')
  })
})

describe('the config store suite', () => {
  const underTest = () => {
    const memory = createMemoryStores({})
    return {
      create: () =>
        Promise.resolve({
          store: memory.stores.config,
          reset: memory.controls.reset,
          seedRaw: memory.controls.seedRaw,
        }),
      memory,
    }
  }

  it('passes against the in-memory store', async () => {
    const result = await runConfigStoreConformance(underTest())

    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('runs every documented case, in order, and reports each one that fails', async () => {
    const result = await runConfigStoreConformance({
      create: () =>
        Promise.resolve({
          store: {
            getAll: () => Promise.reject(new Error('store offline')),
            set: () => Promise.reject(new Error('store offline')),
            delete: () => Promise.reject(new Error('store offline')),
          },
          reset: () => Promise.resolve(),
          seedRaw: () => Promise.resolve(),
        }),
    })

    expect(cases(result.failures)).toEqual(CONFIG_CASES)
  })

  it('says what a value was made from when that is the only difference', async () => {
    const { create, memory } = underTest()
    // A prototype of its own, but nothing of its own to print: the two sides read alike.
    class Row {
      describe(): string {
        return 'a row'
      }
    }
    const result = await runConfigStoreConformance({
      create: () =>
        create().then((controls) => ({
          ...controls,
          store: {
            ...memory.stores.config,
            getAll: async () => {
              const rows = await memory.stores.config.getAll()
              return Object.fromEntries(
                Object.entries(rows).map(([operation, route]) => [
                  operation,
                  Object.assign(new Row(), route),
                ]),
              )
            },
          },
        })),
    })

    expect(result.failures[0]).toContain('to be a plain object')
    expect(result.failures[0]).toContain('but it was a Row')
  })

  it('accepts a store that builds its rows without a prototype', async () => {
    const { create, memory } = underTest()
    const result = await runConfigStoreConformance({
      create: () =>
        create().then((controls) => ({
          ...controls,
          store: {
            ...memory.stores.config,
            getAll: async () => {
              const rows = await memory.stores.config.getAll()
              return Object.fromEntries(
                Object.entries(rows).map(([operation, route]) => [
                  operation,
                  typeof route === 'object' && route !== null
                    ? Object.assign(Object.create(null) as object, route)
                    : route,
                ]),
              )
            },
          },
        })),
    })

    expect(result).toEqual({ passed: true, failures: [], skipped: [] })
  })

  it('fails the named case when a delete takes more than its row', async () => {
    const { create, memory } = underTest()
    const result = await runConfigStoreConformance({
      create: () =>
        create().then((controls) => ({
          ...controls,
          store: {
            ...memory.stores.config,
            delete: async () => {
              for (const operation of Object.keys(await memory.stores.config.getAll())) {
                await memory.stores.config.delete(operation)
              }
            },
          },
        })),
    })

    expect(cases(result.failures)).toContain('delete-removes-row')
  })

  it('fails the named case when a store hands back what it holds', async () => {
    const live = new Map<string, unknown>()
    const result = await runConfigStoreConformance({
      create: () =>
        Promise.resolve({
          store: {
            getAll: () => Promise.resolve(Object.fromEntries(live)),
            set: (operation: string, route: OperationRoute) => {
              live.set(operation, route)
              return Promise.resolve()
            },
            delete: (operation: string) => {
              live.delete(operation)
              return Promise.resolve()
            },
          },
          reset: () => {
            live.clear()
            return Promise.resolve()
          },
          seedRaw: (operation: string, value: unknown) => {
            live.set(operation, value)
            return Promise.resolve()
          },
        }),
    })

    expect(cases(result.failures)).toContain('returned-values-detached')
  })

  it('fails the named case when a store repairs a route it cannot hold', async () => {
    const { create, memory } = underTest()
    const result = await runConfigStoreConformance({
      create: () =>
        create().then((controls) => ({
          ...controls,
          store: {
            ...memory.stores.config,
            set: (operation: string, route: OperationRoute) =>
              memory.stores.config.set(operation, {
                ...route,
                provider: route.provider.replaceAll('\u0000', ''),
              }),
          },
        })),
    })

    expect(cases(result.failures)).toContain('rejects-out-of-domain-strings')
  })

  it('fails the named case when a store keeps only the fields it recognises', async () => {
    const { create, memory } = underTest()
    const result = await runConfigStoreConformance({
      create: () =>
        create().then((controls) => ({
          ...controls,
          store: {
            ...memory.stores.config,
            set: (operation: string, route: { provider: string; model: string }) =>
              memory.stores.config.set(operation, {
                provider: route.provider,
                model: route.model,
              }),
          },
        })),
    })

    expect(cases(result.failures)).toContain('quota-field-verbatim')
  })
})

describe('the controls the suites are driven with', () => {
  it('inspects the row a denied reserve leaves behind', async () => {
    const memory = createMemoryStores({})
    await memory.controls.setTime(new Date('2026-01-15T12:00:00.000Z'))
    const key: QuotaKey = { operation: 'summarize', subjectId: 'user-1' }
    await memory.stores.usage.reserve(key, 0)

    expect(await memory.controls.inspect(key, '2026-01-15')).toEqual({
      reservations: 0,
      counter: { used: 0, lastAdmitted: false },
    })
  })
})

describe('the equality a case reports with', () => {
  it('reads -0 as 0 and never reads NaN as a value that matches', () => {
    expect(deepEqual({ used: -0 }, { used: 0 })).toBe(true)
    expect(deepEqual([1, 2], [1, 2])).toBe(true)
    expect(deepEqual({ used: Number.NaN }, { used: Number.NaN })).toBe(false)
  })
})
