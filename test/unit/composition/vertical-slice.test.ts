/**
 * The vertical slice: one operation end to end through the public surface: `createSwitch`,
 * the `openaiCompatible` factory over a scripted wire, `memoryStores`, with the fallback
 * exercised, the output parsed by the operation's schema, and the daily quota enforced.
 * One green spec demonstrating the assembled whole is fit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createSwitch } from '../../../src/index'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { memoryStores } from '../../../src/stores/memory'
import type { OperationsMap } from '../../../src/types'
import { expectCode } from '../core/helpers'
import { installFetch, jsonResponse } from '../providers/helpers'
import { openaiSuccess } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vertical slice: one operation through the assembled package', () => {
  it('falls back, parses output, aggregates usage, and enforces the daily quota', async () => {
    const responses = [
      jsonResponse(429, { error: { message: 'rate limited' } }),
      openaiSuccess('{"answer":"from-fallback"}', { prompt_tokens: 11, completion_tokens: 4 }),
      openaiSuccess('{"answer":"from-primary"}', { prompt_tokens: 9, completion_tokens: 2 }),
    ]
    let dispatched = 0
    installFetch(() => {
      dispatched += 1
      return responses.shift() ?? jsonResponse(500, null)
    })

    const operations = {
      extract: {
        input: z.object({ text: z.string() }),
        output: z.object({ answer: z.string() }),
        prompt: ({ text }: { text: string }) => `Extract the answer from: ${text}`,
        quota: { perDay: 2 },
        defaultRoute: {
          provider: 'openai',
          model: 'gpt-primary',
          fallback: { provider: 'openai', model: 'gpt-fallback' },
        },
      },
    } as unknown as OperationsMap
    const ai = createSwitch({
      providers: { openai: openaiCompatible({ apiKey: () => 'sk-slice' }) },
      operations,
      stores: memoryStores(),
    })

    // Run 1: the primary is rate-limited; the fallback answers; the JSON is parsed.
    const first = await ai.run('extract', { input: { text: 'a' }, subjectId: 'user-1' })
    expect(first.data).toEqual({ answer: 'from-fallback' })
    expect(first.usedFallback).toBe(true)
    expect(first.route).toEqual({ provider: 'openai', model: 'gpt-fallback' })
    expect(first.attempts.map((a) => a.outcome)).toEqual(['rate_limit', 'succeeded'])
    expect(first.usage).toEqual({ inputTokens: 11, outputTokens: 4 })
    expect(first.usageComplete).toBe(false) // the 429 attempt reported no usage

    // Run 2: the primary answers directly.
    const second = await ai.run('extract', { input: { text: 'b' }, subjectId: 'user-1' })
    expect(second.data).toEqual({ answer: 'from-primary' })
    expect(second.usedFallback).toBe(false)
    expect(second.route).toEqual({ provider: 'openai', model: 'gpt-primary' })

    // Run 3: both daily slots are spent; denied before any dispatch. The fallback shared
    // its run's slot, so two runs consumed two slots, not three attempts' worth.
    expect(dispatched).toBe(3)
    const denied = await expectCode(
      ai.run('extract', { input: { text: 'c' }, subjectId: 'user-1' }),
      'QUOTA_EXCEEDED',
    )
    expect(denied.retryable).toBe(false)
    expect(Number.isNaN(new Date(denied.resetsAt ?? '').getTime())).toBe(false)
    expect(dispatched).toBe(3)

    const quota = await ai.getQuota('extract', 'user-1')
    expect(quota).toMatchObject({ limit: 2, used: 2, remaining: 0 })
  })
})
