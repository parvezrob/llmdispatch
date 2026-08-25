/**
 * The core suite's instruments: a fake runtime, scripted async store doubles, scripted
 * providers, and the standard switch fixture.
 *
 * `memoryStores()` answers synchronously inside `asPromise`, so it cannot script late
 * resolution, late rejection, or unknown-ack; every race, deadline and validation case in
 * this suite runs on these doubles instead, and `memoryStores()` appears only in happy-path
 * integration tests.
 */

import { z } from 'zod'
import { expect } from 'vitest'

import { LLMSwitchError } from '../../../src/errors'
import { createSwitchCore } from '../../../src/core/create-switch'
import type { CoreRuntime, TimerMode } from '../../../src/core/runtime'
import type {
  AttemptRecord,
  CreateSwitchConfig,
  OperationDefinition,
  OperationsMap,
  Provider,
  ProviderRequest,
  ProviderResponse,
  StorePair,
  Switch,
  UsageStore,
} from '../../../src/types'

// ——— promises ———

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Drains the microtask queue completely: one real macrotask turn, before which the event
 * loop runs every queued microtask — however deep the promise chain — to exhaustion.
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One real macrotask turn — what Node needs before reporting an unhandled rejection. */
export function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Attaches handlers immediately and exposes how the promise settled. */
export interface Observed<T> {
  readonly state: 'pending' | 'resolved' | 'rejected'
  readonly value: T | undefined
  readonly error: unknown
}

export function observe<T>(promise: Promise<T>): Observed<T> {
  const observed = {
    state: 'pending' as Observed<T>['state'],
    value: undefined as T | undefined,
    error: undefined as unknown,
  }
  promise.then(
    (value) => {
      observed.state = 'resolved'
      observed.value = value
    },
    (error: unknown) => {
      observed.state = 'rejected'
      observed.error = error
    },
  )
  return observed
}

// ——— unhandled rejections ———

/** Collects unhandled rejections while installed; `stop()` removes the listener. */
export function watchUnhandled(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = []
  const listener = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', listener)
  return {
    seen,
    stop: () => {
      process.removeListener('unhandledRejection', listener)
    },
  }
}

// ——— fake runtime ———

interface FakeTimer {
  id: number
  at: number
  callback: () => void
  mode: TimerMode
}

export interface FakeRuntime extends CoreRuntime {
  /** Fires due timers in time order, flushing microtasks around each, then lands on target. */
  advance(ms: number): Promise<void>
  /** Uncancelled, unfired timers, optionally of one mode. */
  pending(mode?: TimerMode): number
  /** The pending delays (ms from now), sorted, for exact-backoff assertions. */
  pendingDelays(mode?: TimerMode): number[]
}

export function fakeRuntime(start = 1_000_000): FakeRuntime {
  let now = start
  let sequence = 0
  const timers = new Map<number, FakeTimer>()
  const runtime: FakeRuntime = {
    now: () => now,
    schedule(callback, delayMs, mode) {
      sequence += 1
      timers.set(sequence, { id: sequence, at: now + Math.max(0, delayMs), callback, mode })
      return sequence
    },
    cancel(handle) {
      if (typeof handle === 'number') timers.delete(handle)
    },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        await flushMicrotasks()
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (due === undefined) break
        now = Math.max(now, due.at)
        timers.delete(due.id)
        due.callback()
      }
      now = target
      await flushMicrotasks()
    },
    pending(mode) {
      return [...timers.values()].filter((timer) => mode === undefined || timer.mode === mode)
        .length
    },
    pendingDelays(mode) {
      return [...timers.values()]
        .filter((timer) => mode === undefined || timer.mode === mode)
        .map((timer) => timer.at - now)
        .sort((a, b) => a - b)
    },
  }
  return runtime
}

// ——— scripted methods ———

type Handler<A extends unknown[], T> = (...args: A) => T | Promise<T>

export interface Scripted<A extends unknown[], T> {
  (...args: A): Promise<T>
  calls: A[]
  /** Queues one custom handler for the next call. */
  next(handler: Handler<A, T>): void
  nextResolve(value: T): void
  nextReject(error: unknown): void
  /** The next call returns a promise the test settles itself (late, or never). */
  nextHang(): Deferred<T>
  /** Replaces the default behaviour for every unscripted call. */
  always(handler: Handler<A, T>): void
}

export function scripted<A extends unknown[], T>(
  name: string,
  log: string[],
  describeCall: (...args: A) => string,
  defaultHandler: Handler<A, T>,
): Scripted<A, T> {
  const queue: Handler<A, T>[] = []
  let fallback = defaultHandler
  const fn = ((...args: A): Promise<T> => {
    fn.calls.push(args)
    log.push(describeCall(...args))
    const handler = queue.shift() ?? fallback
    // One microtask of asynchrony: a scripted double is an async store, never a sync one.
    return Promise.resolve().then(() => handler(...args))
  }) as Scripted<A, T>
  fn.calls = []
  fn.next = (handler) => queue.push(handler)
  fn.nextResolve = (value) => queue.push(() => value)
  fn.nextReject = (error) =>
    queue.push(() => {
      throw error
    })
  fn.nextHang = () => {
    const gate = deferred<T>()
    queue.push(() => gate.promise)
    return gate
  }
  fn.always = (handler) => {
    fallback = handler
  }
  void name
  return fn
}

// ——— scripted stores ———

export const FIXED_DAY = '2026-08-26'
export const RESETS_AT = '2026-08-27T00:00:00.000Z'
export const EXPIRES_AT = '2026-08-26T00:02:00.000Z'

let reservationSequence = 0

export function grantFor(key: { operation: string; subjectId: string }): {
  ok: true
  reservation: {
    reservationId: string
    key: { operation: string; subjectId: string }
    day: string
  }
  expiresAt: string
} {
  reservationSequence += 1
  return {
    ok: true,
    reservation: {
      reservationId: `r-${String(reservationSequence)}`,
      key: { operation: key.operation, subjectId: key.subjectId },
      day: FIXED_DAY,
    },
    expiresAt: EXPIRES_AT,
  }
}

export interface ScriptedStores {
  stores: StorePair
  log: string[]
  getAll: Scripted<[], Record<string, unknown>>
  set: Scripted<[string, unknown], undefined>
  del: Scripted<[string], undefined>
  reserve: Scripted<[{ operation: string; subjectId: string }, number], unknown>
  commit: Scripted<[string], unknown>
  settle: Scripted<[unknown, string, AttemptRecord[]], undefined>
  snapshot: Scripted<[{ operation: string; subjectId: string }], unknown>
}

export function scriptedStores(): ScriptedStores {
  const log: string[] = []
  const getAll = scripted<[], Record<string, unknown>>(
    'getAll',
    log,
    () => 'getAll',
    () => ({}),
  )
  const set = scripted<[string, unknown], undefined>(
    'set',
    log,
    (operation) => `set ${operation}`,
    () => undefined,
  )
  const del = scripted<[string], undefined>(
    'delete',
    log,
    (operation) => `delete ${operation}`,
    () => undefined,
  )
  const reserve = scripted<[{ operation: string; subjectId: string }, number], unknown>(
    'reserve',
    log,
    (key, limit) => `reserve ${key.subjectId} ${String(limit)}`,
    (key) => grantFor(key),
  )
  const commit = scripted<[string], unknown>(
    'commit',
    log,
    (id) => `commit ${id}`,
    () => 'committed',
  )
  const settle = scripted<[unknown, string, AttemptRecord[]], undefined>(
    'settle',
    log,
    (_reservation, outcome) => `settle ${outcome}`,
    () => undefined,
  )
  const snapshot = scripted<[{ operation: string; subjectId: string }], unknown>(
    'snapshot',
    log,
    (key) => `snapshot ${key.subjectId}`,
    () => ({ used: 0, resetsAt: RESETS_AT }),
  )
  const stores: StorePair = {
    config: { getAll, set, delete: del },
    usage: { reserve, commit, settle, snapshot } as unknown as UsageStore,
  }
  return { stores, log, getAll, set, del, reserve, commit, settle, snapshot }
}

// ——— scripted providers ———

export interface ScriptedProvider {
  provider: Provider
  requests: ProviderRequest[]
  /** How many times `complete` itself (not a prepared dispatcher) was invoked. */
  completeCalls: () => number
  next(
    handler: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
  ): void
  nextResolve(response: ProviderResponse): void
  nextReject(error: unknown): void
  nextHang(): Deferred<ProviderResponse>
  always(
    handler: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
  ): void
}

export function okResponse(data: unknown = { answer: 'ok' }): ProviderResponse {
  return {
    kind: 'complete',
    text: JSON.stringify(data),
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

export function scriptedProvider(): ScriptedProvider {
  const requests: ProviderRequest[] = []
  const queue: ((request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>)[] =
    []
  let calls = 0
  let fallback: (
    request: ProviderRequest,
  ) => ProviderResponse | Promise<ProviderResponse> = () => okResponse()
  const provider: Provider = {
    complete(request) {
      calls += 1
      requests.push(request)
      const handler = queue.shift() ?? fallback
      return Promise.resolve().then(() => handler(request))
    },
  }
  return {
    provider,
    requests,
    completeCalls: () => calls,
    next: (handler) => queue.push(handler),
    nextResolve: (response) => queue.push(() => response),
    nextReject: (error) =>
      queue.push(() => {
        throw error
      }),
    nextHang: () => {
      const gate = deferred<ProviderResponse>()
      queue.push(() => gate.promise)
      return gate
    },
    always: (handler) => {
      fallback = handler
    },
  }
}

// ——— the standard fixture ———

export const ECHO_INPUT = z.object({ text: z.string() })
export const ECHO_OUTPUT = z.object({ answer: z.string() })

export interface FixtureOptions {
  quota?: { perDay: number } | undefined
  timeoutMs?: number
  format?: 'json' | 'json-any' | 'text'
  quality?: OperationDefinition<typeof ECHO_INPUT, typeof ECHO_OUTPUT>['quality']
  fallback?: false
  config?: Partial<CreateSwitchConfig<OperationsMap>>
  operations?: OperationsMap
}

export interface Fixture {
  ai: Switch<OperationsMap>
  runtime: FakeRuntime
  s: ScriptedStores
  p1: ScriptedProvider
  p2: ScriptedProvider
}

/**
 * One operation, `echo`, routed by `defaultRoute` to provider `p1`/model `m1` with fallback
 * `p2`/`m2`. Stores are scripted doubles; the runtime is fake; nothing is prepared unless a
 * test registers a preparing provider itself.
 */
export function fixture(options: FixtureOptions = {}): Fixture {
  const runtime = fakeRuntime()
  const s = scriptedStores()
  const p1 = scriptedProvider()
  const p2 = scriptedProvider()
  const definition: Record<string, unknown> = {
    input: ECHO_INPUT,
    output: ECHO_OUTPUT,
    prompt: ({ text }: { text: string }) => `PROMPT:${text}`,
    defaultRoute: {
      provider: 'p1',
      model: 'm1',
      ...(options.fallback === false ? {} : { fallback: { provider: 'p2', model: 'm2' } }),
    },
  }
  if (options.quota !== undefined) definition.quota = options.quota
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  if (options.format !== undefined) definition.format = options.format
  if (options.quality !== undefined) definition.quality = options.quality
  const operations = options.operations ?? {
    echo: definition as unknown as OperationsMap[string],
  }
  const ai = createSwitchCore(
    {
      providers: { p1: p1.provider, p2: p2.provider },
      operations,
      stores: s.stores,
      ...options.config,
    },
    runtime,
  )
  return { ai, runtime, s, p1, p2 }
}

/** Awaits a rejection and asserts it is an `LLMSwitchError` with the given code. */
export async function expectCode(
  promise: Promise<unknown>,
  code: LLMSwitchError['code'],
): Promise<LLMSwitchError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(LLMSwitchError)
    const typed = error as LLMSwitchError
    expect(typed.code).toBe(code)
    return typed
  }
  throw new Error(`expected a rejection with code ${code}, but the promise resolved`)
}

/** Awaits a rejection and asserts it is the exact value `expected` (unwrapped user error). */
export async function expectSameRejection(
  promise: Promise<unknown>,
  expected: unknown,
): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBe(expected)
    return
  }
  throw new Error('expected a rejection, but the promise resolved')
}
