/**
 * Instruments for the composition suites: a deferred scripted wire (every `fetch` call is
 * held open until the test answers it, so many runs can overlap at the dispatch stage), an
 * OpenAI-shaped success body, a reservation-recording store wrapper for reconciliation
 * assertions, a bounded busy-wait, and a seeded PRNG for the stochastic smoke.
 */

import { vi } from 'vitest'

import type { ReservationEnvelope, StorePair, UsageStore } from '../../../src/types'
import { flushMicrotasks } from '../core/helpers'
import { jsonResponse } from '../providers/helpers'

/** One captured HTTP call, still unanswered until the test calls `respond`. */
export interface WireCall {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
  respond: (response: Response) => void
}

export interface Wire {
  calls: WireCall[]
}

/**
 * Stubs global `fetch` so every call parks in `calls` until the test resolves it.
 *
 * An already-aborted signal rejects immediately, as the real fetch does. A signal firing
 * *after* dispatch is deliberately ignored, no composition test aborts a parked call, and
 * a future one would need an abort listener here first. Restore with
 * `vi.unstubAllGlobals()` in `afterEach`.
 */
export function wireFetch(): Wire {
  const calls: WireCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (init.signal?.aborted === true) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      return new Promise<Response>((resolve) => {
        const headers: Record<string, string> = {}
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value
        })
        calls.push({
          url,
          method: init.method ?? 'GET',
          headers,
          body:
            typeof init.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : {},
          respond: resolve,
        })
      })
    }),
  )
  return { calls }
}

/** A 200 chat completion that terminates `stop` with the given text and usage counters. */
export function openaiSuccess(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } = {
    prompt_tokens: 7,
    completion_tokens: 3,
  },
): Response {
  return jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage,
  })
}

/** Reads the launching run's index back out of a captured request's `run-<n>` prompt. */
export function runIndexOf(call: WireCall): number {
  const messages = call.body.messages as { content?: unknown }[]
  const content = messages[0]?.content
  const match = typeof content === 'string' ? /run-(\d+)/.exec(content) : null
  const index = match?.[1]
  if (index === undefined) throw new Error('wire request carries no run marker')
  return Number(index)
}

/**
 * A store pair whose usage store records every granted reservation envelope and every
 * acknowledged commit, so "committed == dispatched runs" is a direct assertion.
 */
export function recordingStores(inner: StorePair): {
  stores: StorePair
  envelopes: ReservationEnvelope[]
  commits: string[]
} {
  const envelopes: ReservationEnvelope[] = []
  const commits: string[] = []
  const usage: UsageStore = {
    async reserve(key, limit) {
      const result = await inner.usage.reserve(key, limit)
      if (result.ok) envelopes.push(result.reservation)
      return result
    },
    async commit(reservationId) {
      const result = await inner.usage.commit(reservationId)
      if (result === 'committed') commits.push(reservationId)
      return result
    },
    settle: (reservation, outcome, attempts) =>
      inner.usage.settle(reservation, outcome, attempts),
    snapshot: (key) => inner.usage.snapshot(key),
  }
  return { stores: { config: inner.config, usage }, envelopes, commits }
}

/** Flushes microtask turns until `predicate` holds; fails loudly instead of hanging. */
export async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return
    await flushMicrotasks()
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * mulberry32: a tiny deterministic PRNG. The seed pins the draw sequence exactly; which
 * run receives which drawn outcome also depends on dispatch arrival order.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates over a copy, driven by the seeded PRNG. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = copy[i]
    const b = copy[j]
    if (a === undefined || b === undefined) continue
    copy[i] = b
    copy[j] = a
  }
  return copy
}
