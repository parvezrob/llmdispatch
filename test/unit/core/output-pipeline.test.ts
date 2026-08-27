/**
 * The output pipeline and the provider seam (spec §3): fence unwrap, the format
 * matrix, termination-before-content and the body shape it still requires, the quality
 * verdict matrix, settled-then-unwrapped user errors, full request forwarding, the fresh
 * fallback timeout, and the hostile ProviderResponse matrix.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { LLMDispatchError } from '../../../src/errors'
import type { OperationsMap, ProviderResponse } from '../../../src/types'
import {
  expectCode,
  expectSameRejection,
  fixture,
  flushMicrotasks,
  observe,
  ECHO_INPUT,
  ECHO_OUTPUT,
} from './helpers'

const INPUT = { input: { text: 'hi' } }

function complete(text: string): ProviderResponse {
  return { kind: 'complete', text, usage: { inputTokens: 3, outputTokens: 4 } }
}

describe('parsing and the format matrix', () => {
  it('unwraps a single whole-response code fence', async () => {
    const f = fixture()
    f.p1.nextResolve(complete('```json\n{"answer":"fenced"}\n```'))
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toEqual({ answer: 'fenced' })
  })

  it('leaves an interior fence alone, only a whole-response fence is wrapping', async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: z.string(),
        prompt: () => 'p',
        format: 'json-any',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    f.p1.nextResolve(complete('"before ```json inside``` after"'))
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toBe('before ```json inside``` after')
  })

  it('rejects unparseable JSON as output_rejected, fallback-eligible', async () => {
    const f = fixture()
    f.p1.nextResolve(complete('not json at all'))
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['output_rejected', 'succeeded'])
  })

  it("rejects a non-object top level for 'json' (the default)", async () => {
    const f = fixture({ fallback: false })
    for (const text of ['[1,2]', '42', 'null', '"str"']) {
      f.p1.nextResolve(complete(text))
      const error = await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
      expect(error.retryable).toBe(true)
      expect(error.attempts?.at(-1)?.outcome).toBe('output_rejected')
    }
  })

  it('rejects a schema failure (ZodError) as output_rejected', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextResolve(complete('{"answer": 42}'))
    await expectCode(f.ai.run('echo', INPUT), 'OUTPUT_REJECTED')
  })

  it("accepts a scalar and an array under 'json-any'", async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: z.union([z.number(), z.array(z.number())]),
        prompt: () => 'p',
        format: 'json-any',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    for (const [text, expected] of [
      ['42', 42],
      ['[1,2]', [1, 2]],
    ] as const) {
      const f = fixture({ operations })
      f.p1.nextResolve(complete(text))
      const result = await f.ai.run('echo', INPUT)
      expect(result.data).toEqual(expected)
    }
  })

  it("bypasses JSON parsing entirely under 'text'", async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: z.string(),
        prompt: () => 'p',
        format: 'text',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    f.p1.nextResolve(complete('this is { not json')) // would fail JSON.parse
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toBe('this is { not json')
  })
})

describe('termination before content', () => {
  const TERMINATIONS = [
    { kind: 'refused', code: 'PROVIDER_FAILED' },
    { kind: 'truncated', code: 'OUTPUT_REJECTED' },
  ] as const

  for (const { kind, code } of TERMINATIONS) {
    it(`classifies ${kind} on the termination alone, leaving the §3 stages unrun`, async () => {
      let outputParses = 0
      let qualityCalls = 0
      const operations = {
        echo: {
          input: ECHO_INPUT,
          output: {
            parseAsync: (value: unknown) => {
              outputParses += 1
              return Promise.resolve(value)
            },
          },
          prompt: () => 'p',
          quality: () => {
            qualityCalls += 1
            return { ok: true }
          },
          defaultRoute: { provider: 'p1', model: 'm1' },
        },
      } as unknown as OperationsMap
      const f = fixture({ operations })
      // A well-shaped, parseable body: the termination decides, the content stages never run.
      f.p1.nextResolve({
        kind,
        text: '{"answer":"partial"}',
        usage: { inputTokens: 1, outputTokens: 2 },
      })
      const error = await expectCode(f.ai.run('echo', INPUT), code)
      expect(error.attempts?.[0]?.outcome).toBe(kind)
      expect(error.attempts?.[0]?.usage).toEqual({ inputTokens: 1, outputTokens: 2 }) // billable
      expect(outputParses).toBe(0)
      expect(qualityCalls).toBe(0)
    })
  }

  // §6: `text: string` belongs to every variant of the union, so a terminated response whose
  // body fails the shape is malformed_response: retryable and fallback-eligible.
  const badBodies: { name: string; make: (kind: string) => unknown }[] = [
    { name: 'no text at all', make: (kind) => ({ kind, usage: null }) },
    { name: 'a non-string text', make: (kind) => ({ kind, text: 42, usage: null }) },
    {
      name: 'a throwing text getter',
      make: (kind) => {
        const response = { kind, usage: null }
        Object.defineProperty(response, 'text', {
          get(): string {
            throw new Error('hostile body')
          },
          enumerable: true,
        })
        return response
      },
    },
  ]
  for (const { kind } of TERMINATIONS) {
    for (const { name, make } of badBodies) {
      it(`classifies ${kind} with ${name} as malformed_response, fallback-eligible`, async () => {
        const f = fixture()
        f.p1.nextResolve(make(kind) as ProviderResponse)
        f.p2.nextResolve(make(kind) as ProviderResponse)
        const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
        expect(error.retryable).toBe(true)
        expect(f.p2.requests.length).toBe(1) // the fallback IS attempted
        expect(error.attempts?.map((a) => a.outcome)).toEqual([
          'malformed_response',
          'malformed_response',
        ])
      })
    }
  }
})

describe('the quality gate', () => {
  it('passes on { ok: true }', async () => {
    const f = fixture({ quality: () => ({ ok: true }) })
    const result = await f.ai.run('echo', INPUT)
    expect(result.data).toEqual({ answer: 'ok' })
  })

  it('rejects on { ok: false } as output_rejected, fallback-eligible', async () => {
    let calls = 0
    const f = fixture({
      quality: () => {
        calls += 1
        return calls === 1 ? { ok: false, reason: 'too short' } : { ok: true }
      },
    })
    const result = await f.ai.run('echo', INPUT)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['output_rejected', 'succeeded'])
  })

  it('treats a malformed verdict as quality_error: settled first, then unwrapped, no fallback spend', async () => {
    for (const verdict of [null, 'yes', { ok: 'yes' }, { ok: false, reason: 42 }]) {
      const f = fixture({
        quota: { perDay: 5 },
        quality: () => verdict as never,
      })
      let caught: unknown
      try {
        await f.ai.run('echo', { ...INPUT, subjectId: 'u' })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(TypeError)
      expect(caught).not.toBeInstanceOf(LLMDispatchError)
      expect((caught as TypeError).message).toContain('malformed verdict')
      expect(f.s.settle.calls.length).toBe(1) // settled before the throw reached the caller
      expect(f.s.settle.calls[0]![1]).toBe('failed')
      expect(f.s.settle.calls[0]![2].map((a) => a.outcome)).toEqual(['quality_error'])
      expect(f.p2.requests.length).toBe(0) // no additional fallback spend
    }
  })

  it('treats a thrown quality gate as quality_error with the raw error unwrapped', async () => {
    const bug = new Error('gate exploded')
    const f = fixture({
      quota: { perDay: 5 },
      quality: () => {
        throw bug
      },
    })
    await expectSameRejection(f.ai.run('echo', { ...INPUT, subjectId: 'u' }), bug)
    expect(f.s.settle.calls[0]![2].map((a) => a.outcome)).toEqual(['quality_error'])
    expect(f.p2.requests.length).toBe(0)
  })

  /** The standard echo operation, quota'd, whose output transform throws `bug`. */
  function throwingTransform(bug: unknown): OperationsMap {
    return {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT.transform(() => {
          throw bug
        }),
        prompt: () => 'p',
        quota: { perDay: 5 },
        defaultRoute: {
          provider: 'p1',
          model: 'm1',
          fallback: { provider: 'p2', model: 'm2' },
        },
      },
    }
  }

  it('treats a non-Zod output transform exception as output_schema_error, settled and unwrapped', async () => {
    const bug = new RangeError('transform exploded')
    const f = fixture({ operations: throwingTransform(bug) })
    await expectSameRejection(f.ai.run('echo', { ...INPUT, subjectId: 'u' }), bug)
    expect(f.s.settle.calls.length).toBe(1)
    expect(f.s.settle.calls[0]![2].map((a) => a.outcome)).toEqual(['output_schema_error'])
    expect(f.p2.requests.length).toBe(0) // no further fallback
  })

  it('keeps a thrown object whose name getter throws on the non-Zod path, attempt recorded', async () => {
    const bug: Record<string, unknown> = {}
    Object.defineProperty(bug, 'name', {
      get(): string {
        throw new Error('the ZodError probe must not escape processOutput')
      },
      enumerable: true,
    })
    const f = fixture({ operations: throwingTransform(bug) })
    await expectSameRejection(f.ai.run('echo', { ...INPUT, subjectId: 'u' }), bug) // Object.is
    expect(f.s.settle.calls.length).toBe(1)
    expect(f.s.settle.calls[0]![1]).toBe('failed')
    expect(f.s.settle.calls[0]![2].map((a) => a.outcome)).toEqual(['output_schema_error'])
  })
})

describe('request forwarding', () => {
  it('forwards every ProviderRequest field from the route and the operation', async () => {
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: ({ text }: { text: string }) => `PROMPT:${text}`,
        format: 'json',
        defaultRoute: {
          provider: 'p1',
          model: 'the-model',
          maxOutputTokens: 512,
          temperature: 0.3,
        },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    await f.ai.run('echo', INPUT)
    const request = f.p1.requests[0]!
    expect(request.parts).toEqual([{ type: 'text', text: 'PROMPT:hi' }])
    expect(request.model).toBe('the-model')
    expect(request.responseFormat).toEqual({ type: 'json', topLevel: 'object' })
    expect(request.maxOutputTokens).toBe(512)
    expect(request.temperature).toBe(0.3)
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })

  it('omits unset optional fields instead of defaulting them', async () => {
    const f = fixture()
    await f.ai.run('echo', INPUT)
    const request = f.p1.requests[0]!
    expect('maxOutputTokens' in request).toBe(false)
    expect('temperature' in request).toBe(false)
  })

  it("derives topLevel 'any' for json-any and type 'text' for text", async () => {
    for (const [format, expected] of [
      ['json-any', { type: 'json', topLevel: 'any' }],
      ['text', { type: 'text' }],
    ] as const) {
      const operations = {
        echo: {
          input: ECHO_INPUT,
          output: format === 'text' ? z.string() : ECHO_OUTPUT,
          prompt: () => 'p',
          format,
          defaultRoute: { provider: 'p1', model: 'm1' },
        },
      } as unknown as OperationsMap
      const f = fixture({ operations })
      f.p1.nextResolve(complete(format === 'text' ? 'plain' : '{"answer":"ok"}'))
      await f.ai.run('echo', INPUT)
      expect(f.p1.requests[0]!.responseFormat).toEqual(expected)
    }
  })

  it('gives the fallback a fresh timeoutMs and its own composed signal', async () => {
    const f = fixture({ timeoutMs: 2000 })
    const primaryHang = f.p1.nextHang()
    const fallbackHang = f.p2.nextHang()
    const run = observe(f.ai.run('echo', INPUT))
    await flushMicrotasks()
    await f.runtime.advance(2000) // the primary times out; the fallback dispatches
    await flushMicrotasks()
    expect(f.p2.requests.length).toBe(1)
    const primaryRequest = f.p1.requests[0]!
    const fallbackRequest = f.p2.requests[0]!
    expect(fallbackRequest.signal).not.toBe(primaryRequest.signal)
    expect(primaryRequest.signal.aborted).toBe(true)
    expect(fallbackRequest.signal.aborted).toBe(false) // a fresh controller
    await f.runtime.advance(1999)
    expect(run.state).toBe('pending') // the fallback's own 2 s, restarted at its dispatch
    await f.runtime.advance(1)
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    expect((run.error as LLMDispatchError).attempts?.map((a) => a.outcome)).toEqual([
      'timeout',
      'timeout',
    ])
    void primaryHang
    void fallbackHang
  })
})

describe('the hostile ProviderResponse matrix', () => {
  const hostiles: { name: string; response: unknown }[] = [
    { name: 'an unknown kind', response: { kind: 'finished', text: 'x', usage: null } },
    {
      name: 'a non-string text on complete',
      response: { kind: 'complete', text: 42, usage: null },
    },
    { name: 'a null response', response: null },
    { name: 'a string response', response: 'done' },
    { name: 'a numeric response', response: 7 },
  ]
  for (const { name, response } of hostiles) {
    it(`classifies ${name} as malformed_response`, async () => {
      const f = fixture({ fallback: false })
      f.p1.nextResolve(response as ProviderResponse)
      const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
      expect(error.retryable).toBe(true)
      expect(error.attempts?.[0]?.outcome).toBe('malformed_response')
    })
  }

  it('normalizes invalid usage to null without failing the run', async () => {
    for (const usage of [
      { inputTokens: -1, outputTokens: 2 },
      { inputTokens: 0.5, outputTokens: 2 },
      { inputTokens: 2 ** 53, outputTokens: 2 },
      { inputTokens: '3', outputTokens: 2 },
      { inputTokens: 3 },
      'lots',
      42,
    ]) {
      const f = fixture()
      f.p1.nextResolve({ kind: 'complete', text: '{"answer":"ok"}', usage: usage as never })
      const result = await f.ai.run('echo', INPUT)
      expect(result.data).toEqual({ answer: 'ok' })
      expect(result.attempts[0]!.usage).toBeNull()
      expect(result.usageComplete).toBe(false)
    }
  })
})
