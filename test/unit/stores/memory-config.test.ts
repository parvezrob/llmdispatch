import { describe, expect, it } from 'vitest'

import { createMemoryStores, memoryStores } from '../../../src/stores/memory'
import type { OperationRoute } from '../../../src/types'

const ROUTE: OperationRoute = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  maxOutputTokens: 1024,
  temperature: 0.2,
  quota: { perDay: 25 },
  fallback: { provider: 'openai', model: 'gpt-5' },
}

describe('the in-memory config store', () => {
  it('returns a stored route with every field it was given', async () => {
    const { config } = memoryStores()
    await config.set('summarize', ROUTE)

    expect(await config.getAll()).toEqual({ summarize: ROUTE })
  })

  it('removes a row on delete and leaves the others alone', async () => {
    const { config } = memoryStores()
    await config.set('summarize', ROUTE)
    await config.set('translate', ROUTE)
    await config.delete('summarize')

    expect(Object.keys(await config.getAll())).toEqual(['translate'])
    // Deleting a row that was never there is not an error.
    await expect(config.delete('summarize')).resolves.toBeUndefined()
  })

  it('reads back a raw row exactly as it was seeded, however wrong it is', async () => {
    const { stores, controls } = createMemoryStores({})
    const rows = {
      'a-string': 'not a route',
      'a-number': 7,
      'a-null': null,
      'a-wrong-type': { provider: 'claude', model: 42 },
    }
    for (const [operation, value] of Object.entries(rows)) {
      await controls.seedRaw(operation, value)
    }

    expect(await stores.config.getAll()).toEqual(rows)
  })

  it('keeps a quota on a route verbatim, like any other field', async () => {
    const { config } = memoryStores()
    await config.set('summarize', { provider: 'claude', model: 'x', quota: { perDay: 0 } })

    expect(await config.getAll()).toEqual({
      summarize: { provider: 'claude', model: 'x', quota: { perDay: 0 } },
    })
  })

  it('treats operation names that collide with object internals as ordinary keys', async () => {
    const { config } = memoryStores()
    const names = ['', '__proto__', 'constructor', 'toString']
    for (const name of names) {
      await config.set(name, { ...ROUTE, model: `model-for-${name}` })
    }

    const all = await config.getAll()
    expect(Object.keys(all).sort()).toEqual([...names].sort())
    for (const name of names) {
      expect(Object.hasOwn(all, name)).toBe(true)
      expect(all[name]).toEqual({ ...ROUTE, model: `model-for-${name}` })
    }
    // Nothing reached a prototype on the way through.
    expect(Object.getPrototypeOf(all)).toBe(Object.prototype)
    expect(typeof {}.toString).toBe('function')
  })

  it('is detached from the object a caller passes in and from the one it reads', async () => {
    const { config } = memoryStores()
    const written = { ...ROUTE, fallback: { ...ROUTE.fallback } } as OperationRoute
    await config.set('summarize', written)

    written.model = 'edited-after-set'
    if (written.fallback) written.fallback.provider = 'edited-after-set'
    expect(await config.getAll()).toEqual({ summarize: ROUTE })

    const all = await config.getAll()
    delete all.summarize
    expect(await config.getAll()).toEqual({ summarize: ROUTE })
  })
})
