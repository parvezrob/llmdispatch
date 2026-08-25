/**
 * Config resolution (spec §2): the per-operation cache, the generation counter, the
 * per-operation mutation mutex, and the admin reads.
 *
 * Coherence rules, all from §2: every mutation outcome — success, rejection, timeout, and a
 * late ack after a timeout — bumps the operation's generation and invalidates its cache
 * entry; a read begun under an older generation installs nothing; cache age is stamped when
 * the read completes, not when it starts. Mutations are serialized per operation (FIFO, one
 * in flight), and the mutex is released at the store call's deadline even though the store
 * promise is still pending — the 10 s budget binds the store call itself, so a queued
 * mutation's own call still gets its full 10 s from the moment it starts.
 *
 * @module
 */

import { configStoreUnavailable, invalidConfigLocal } from '../errors'
import type { ConfigStore, OperationConfigView, OperationRoute } from '../types'
import { DeadlineExceeded, callWithDeadline, suppress } from './abort'
import type { CoreRuntime } from './runtime'
import { cloneRoute, isRecord, validateRoute } from './validate'

/** The §6a config-store deadlines. */
const GET_ALL_DEADLINE_MS = 5000
const MUTATION_DEADLINE_MS = 10_000

/** One operation's declared shape, as resolution needs it. */
export interface DeclaredOperation {
  defaultRoute: OperationRoute | undefined
}

/** One cached resolution: the effective route, stamped at read completion. */
interface CacheEntry {
  route: OperationRoute
  stampedAt: number
}

/** One operation's FIFO mutation queue; `locked` is whether a holder currently exists. */
interface OperationMutex {
  locked: boolean
  waiters: (() => void)[]
}

/** The resolution and admin surface `createSwitch` wires the run and admin methods to. */
export interface ConfigService {
  /** Stage-4 resolution: cache honoured and updated. Throws the §2 codes. */
  resolve(operation: string): Promise<OperationRoute>
  /** The `getConfig` view: bypasses the cache and does not populate it. */
  view(): Promise<Record<string, OperationConfigView>>
  /** `setConfig`'s store write, behind the mutex; the route is already validated. */
  set(operation: string, route: OperationRoute): Promise<void>
  /** `resetConfig`'s store delete, behind the same mutex. */
  reset(operation: string): Promise<void>
}

/**
 * Builds the config service for one switch.
 *
 * @param operations Every declared operation, keyed by name — the source of `defaultRoute`.
 * @param registered The registered provider IDs, for validation-on-read of stored rows.
 */
export function createConfigService(opts: {
  runtime: CoreRuntime
  store: ConfigStore
  configTtlMs: number
  operations: ReadonlyMap<string, DeclaredOperation>
  registered: ReadonlySet<string>
}): ConfigService {
  const { runtime, store, configTtlMs, operations, registered } = opts
  const cache = new Map<string, CacheEntry>()
  const generations = new Map<string, number>()
  const mutexes = new Map<string, OperationMutex>()

  function generationOf(operation: string): number {
    return generations.get(operation) ?? 0
  }

  /** Every mutation outcome bumps and invalidates (§2 cache coherence). */
  function bumpAndInvalidate(operation: string): void {
    generations.set(operation, generationOf(operation) + 1)
    cache.delete(operation)
  }

  /** Installs a completed read, unless a mutation has moved the generation since it began. */
  function install(operation: string, route: OperationRoute, readGeneration: number): void {
    if (generationOf(operation) !== readGeneration) return
    cache.set(operation, { route, stampedAt: runtime.now() })
  }

  async function readAll(deadlineWhat: string): Promise<Record<string, unknown>> {
    const raw = await callWithDeadline(
      runtime,
      GET_ALL_DEADLINE_MS,
      deadlineWhat,
      'referenced',
      () => store.getAll(),
    )
    if (!isRecord(raw)) {
      // Fail-closed: a malformed container must never read as "no rows" and activate
      // defaults (§2).
      throw new MalformedContainer()
    }
    return raw
  }

  async function resolve(operation: string): Promise<OperationRoute> {
    const declared = operations.get(operation)
    const entry = cache.get(operation)
    if (
      entry !== undefined &&
      configTtlMs > 0 &&
      runtime.now() - entry.stampedAt < configTtlMs
    ) {
      return entry.route
    }
    const readGeneration = generationOf(operation)
    let rows: Record<string, unknown>
    try {
      rows = await readAll('config store getAll()')
    } catch (error) {
      // §2: `defaultRoute` is never an outage fallback, and outages are not cached.
      throw configStoreUnavailable(operation, error)
    }
    if (!Object.hasOwn(rows, operation)) {
      const defaultRoute = declared?.defaultRoute
      if (defaultRoute === undefined) {
        throw invalidConfigLocal(operation, 'no stored route and no defaultRoute')
      }
      // Negative-cached: the default is the effective route until something is stored.
      install(operation, defaultRoute, readGeneration)
      return defaultRoute
    }
    const checked = validateRoute(rows[operation], registered)
    if (!checked.ok) {
      // Malformed rows are isolated to this operation and never cached (§2).
      throw invalidConfigLocal(operation, `stored route ${checked.problem}`)
    }
    install(operation, checked.value, readGeneration)
    return checked.value
  }

  async function view(): Promise<Record<string, OperationConfigView>> {
    let rows: Record<string, unknown>
    try {
      rows = await readAll('config store getAll()')
    } catch (error) {
      throw configStoreUnavailable('*', error)
    }
    // Null-prototype so a hostile operation name like `__proto__` is an ordinary key.
    const views = Object.create(null) as Record<string, OperationConfigView>
    for (const [operation, declared] of operations) {
      const defaultRoute =
        declared.defaultRoute === undefined ? null : cloneRoute(declared.defaultRoute)
      if (!Object.hasOwn(rows, operation)) {
        views[operation] = { stored: null, effective: defaultRoute }
        continue
      }
      const checked = validateRoute(rows[operation], registered)
      views[operation] = checked.ok
        ? { stored: checked.value, effective: cloneRoute(checked.value) }
        : { stored: 'malformed', effective: null }
    }
    return views
  }

  function mutexOf(operation: string): OperationMutex {
    let mutex = mutexes.get(operation)
    if (mutex === undefined) {
      mutex = { locked: false, waiters: [] }
      mutexes.set(operation, mutex)
    }
    return mutex
  }

  function acquire(operation: string): Promise<void> {
    const mutex = mutexOf(operation)
    if (!mutex.locked) {
      mutex.locked = true
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      mutex.waiters.push(resolve)
    })
  }

  function release(operation: string): void {
    const mutex = mutexOf(operation)
    const next = mutex.waiters.shift()
    if (next === undefined) {
      mutex.locked = false
      return
    }
    next()
  }

  /**
   * One serialized mutation. The mutex is released when the store call settles or times
   * out — at the deadline the store promise is still pending, and its late outcome bumps
   * the generation again when it finally lands (§2).
   */
  async function mutate(
    operation: string,
    call: () => Promise<void>,
    what: string,
  ): Promise<void> {
    await acquire(operation)
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      release(operation)
    }
    try {
      let storePromise: Promise<void>
      try {
        storePromise = (async () => {
          await call()
        })()
      } catch (error) {
        // Unreachable for a store that returns promises; kept so a hostile synchronous
        // throw still bumps and maps like any other rejection.
        bumpAndInvalidate(operation)
        throw configStoreUnavailable(operation, error)
      }
      try {
        await callWithDeadline(
          runtime,
          MUTATION_DEADLINE_MS,
          what,
          'referenced',
          () => storePromise,
        )
      } catch (error) {
        bumpAndInvalidate(operation)
        if (error instanceof DeadlineExceeded) {
          // Unknown ack: the write may still land. When it does — either way — it bumps
          // again, so a stale entry cached in between is invalidated (§2).
          suppress(
            storePromise.then(
              () => {
                bumpAndInvalidate(operation)
              },
              () => {
                bumpAndInvalidate(operation)
              },
            ),
          )
        }
        throw configStoreUnavailable(operation, error)
      }
      bumpAndInvalidate(operation)
    } finally {
      releaseOnce()
    }
  }

  return {
    resolve,
    view,
    set: (operation, route) =>
      mutate(operation, () => store.set(operation, route), 'config store set()'),
    reset: (operation) =>
      mutate(operation, () => store.delete(operation), 'config store delete()'),
  }
}

/** The fail-closed §2 container failure, chained as the public error's `cause`. */
class MalformedContainer extends Error {
  constructor() {
    super('config store getAll() returned a non-record; refusing to read it as "no rows"')
    this.name = 'MalformedContainer'
  }
}
