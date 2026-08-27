/**
 * Classification and whose-bug (spec §5b): every row at the classification level with
 * the kind↔outcome agreement invariant, fallback eligibility per row, the read-once TOCTOU
 * defence for `kind` and `status`, and the crossed-origin fixtures — origin decides, never
 * the thrown class.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { LLMDispatchError } from '../../../src/errors'
import { ProviderError } from '../../../src/errors'
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

interface Row {
  name: string
  arrange: (f: ReturnType<typeof fixture>, which: 'p1' | 'p2') => void
  outcome: string
  code: LLMDispatchError['code']
  retryable: boolean
  fallback: boolean
}

const truncatedResponse: ProviderResponse = {
  kind: 'truncated',
  text: 'part',
  usage: { inputTokens: 1, outputTokens: 1 },
}
const refusedResponse: ProviderResponse = {
  kind: 'refused',
  text: '',
  usage: { inputTokens: 1, outputTokens: 0 },
}

/** Every §5b row a dispatch can produce, with its literal terminal columns. */
const rows: Row[] = [
  {
    name: 'transient',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('transient', { status: 503 }))
    },
    outcome: 'transient',
    code: 'PROVIDER_FAILED',
    retryable: true,
    fallback: true,
  },
  {
    name: 'rate_limit',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('rate_limit', { status: 429 }))
    },
    outcome: 'rate_limit',
    code: 'PROVIDER_FAILED',
    retryable: true,
    fallback: true,
  },
  {
    name: 'malformed_response',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('malformed_response'))
    },
    outcome: 'malformed_response',
    code: 'PROVIDER_FAILED',
    retryable: true,
    fallback: true,
  },
  {
    name: 'truncated',
    arrange: (f, which) => {
      f[which].nextResolve(truncatedResponse)
    },
    outcome: 'truncated',
    code: 'OUTPUT_REJECTED',
    retryable: true,
    fallback: true,
  },
  {
    name: 'output_rejected',
    arrange: (f, which) => {
      f[which].nextResolve({ kind: 'complete', text: 'not json', usage: null })
    },
    outcome: 'output_rejected',
    code: 'OUTPUT_REJECTED',
    retryable: true,
    fallback: true,
  },
  {
    name: 'refused',
    arrange: (f, which) => {
      f[which].nextResolve(refusedResponse)
    },
    outcome: 'refused',
    code: 'PROVIDER_FAILED',
    retryable: false,
    fallback: false,
  },
  {
    name: 'auth',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('auth', { status: 401 }))
    },
    outcome: 'auth',
    code: 'INVALID_CONFIG',
    retryable: false,
    fallback: false, // default; the flag variant is asserted separately
  },
  {
    name: 'model_not_found',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('model_not_found', { status: 404 }))
    },
    outcome: 'model_not_found',
    code: 'INVALID_CONFIG',
    retryable: false,
    fallback: false,
  },
  {
    name: 'invalid_request',
    arrange: (f, which) => {
      f[which].nextReject(new ProviderError('invalid_request', { status: 413 }))
    },
    outcome: 'invalid_request',
    code: 'PROVIDER_FAILED',
    retryable: false,
    fallback: false,
  },
  {
    name: 'provider_unclassified',
    arrange: (f, which) => {
      f[which].nextReject(new Error('a plain failure'))
    },
    outcome: 'provider_unclassified',
    code: 'PROVIDER_FAILED',
    retryable: false,
    fallback: false,
  },
]

describe('every §5b row at the classification level', () => {
  for (const row of rows) {
    it(`classifies ${row.name}: terminal code, literal retryable, and kind↔outcome agreement`, async () => {
      const f = fixture({ fallback: false })
      row.arrange(f, 'p1')
      const error = await expectCode(f.ai.run('echo', INPUT), row.code)
      expect(error.retryable).toBe(row.retryable)
      // The call-site invariant: the classification chosen and the recorded outcome agree.
      expect(error.attempts?.map((a) => a.outcome)).toEqual([row.outcome])
      if (row.code === 'INVALID_CONFIG') expect(error.detectedAt).toBe('provider')
    })

    it(`${row.fallback ? 'falls back' : 'does not fall back'} on ${row.name}`, async () => {
      const f = fixture()
      row.arrange(f, 'p1')
      if (row.fallback) {
        const result = await f.ai.run('echo', INPUT)
        expect(result.usedFallback).toBe(true)
        expect(result.attempts.map((a) => a.outcome)).toEqual([row.outcome, 'succeeded'])
      } else {
        await expectCode(f.ai.run('echo', INPUT), row.code)
        expect(f.p2.requests.length).toBe(0)
      }
    })
  }

  it("classifies the adapter's 'aborted' as ABORTED only when the caller's signal fired", async () => {
    // Both directions live in the abort suite; here the row's terminal columns are pinned once more.
    const f = fixture({ fallback: false })
    const controller = new AbortController()
    f.p1.next(() => {
      controller.abort()
      throw new ProviderError('aborted')
    })
    const error = await expectCode(
      f.ai.run('echo', INPUT, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['aborted'])
  })

  it('reclassifies provider_unclassified to transient under treatUnclassifiedAsTransient', async () => {
    const f = fixture({ fallback: false, config: { treatUnclassifiedAsTransient: true } })
    f.p1.nextReject(new Error('a plain failure'))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(true) // the transient row's literal
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient'])
  })

  it('makes auth and model_not_found fallback-eligible with the flag, primary only', async () => {
    for (const kind of ['auth', 'model_not_found'] as const) {
      const f = fixture({ config: { fallbackOnAuthOrModelNotFound: true } })
      f.p1.nextReject(new ProviderError(kind))
      const result = await f.ai.run('echo', INPUT)
      expect(result.usedFallback).toBe(true)
      expect(result.attempts.map((a) => a.outcome)).toEqual([kind, 'succeeded'])
    }
  })
})

describe('read-once TOCTOU defence', () => {
  /** A branded object whose `kind`/`status` getters answer per read. `is()` reads first. */
  function shifty(
    kinds: (string | (() => never))[],
    statuses: (number | undefined | (() => never))[],
  ) {
    let kindReads = 0
    let statusReads = 0
    const value = { message: 'shifty' } as Record<PropertyKey, unknown>
    value[Symbol.for('llmdispatch.ProviderError')] = true
    Object.defineProperty(value, 'kind', {
      enumerable: true,
      get(): unknown {
        const read = kinds[Math.min(kindReads, kinds.length - 1)]
        kindReads += 1
        if (typeof read === 'function') read()
        return read
      },
    })
    Object.defineProperty(value, 'status', {
      enumerable: true,
      get(): unknown {
        const read = statuses[Math.min(statusReads, statuses.length - 1)]
        statusReads += 1
        if (typeof read === 'function') read()
        return read
      },
    })
    return value
  }

  const boom = (): never => {
    throw new Error('second read')
  }

  it('classifies from its captured kind, stable against a mutating second read', async () => {
    const f = fixture({ fallback: false })
    // is() sees 'transient' (first read); the core's own single read sees 'rate_limit';
    // any later read would see 'auth'. Classification and record must both say rate_limit.
    f.p1.nextReject(shifty(['transient', 'rate_limit', 'auth'], [429, 429]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['rate_limit'])
    expect(error.attempts?.[0]?.status).toBe(429)
  })

  it('follows the provider_unclassified row when the captured kind is outside the set', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextReject(shifty(['transient', 'weird_kind'], [undefined]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.retryable).toBe(false)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['provider_unclassified'])
  })

  it('stays stable when the second kind read throws', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextReject(shifty(['transient', boom], [503]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['provider_unclassified'])
  })

  it('drops the status when its second read throws, keeping the classification', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextReject(shifty(['invalid_request', 'invalid_request'], [413, boom]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['invalid_request'])
    expect(error.attempts?.[0]?.status).toBeUndefined()
  })

  it('revalidates a mutated status snapshot: a non-number is omitted', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextReject(shifty(['invalid_request', 'invalid_request'], [413, 'teapot' as never]))
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error.attempts?.[0]?.status).toBeUndefined()
  })

  it('propagates a normal status into the attempt record, and omits an absent one', async () => {
    const f = fixture({ fallback: false })
    f.p1.nextReject(new ProviderError('invalid_request', { status: 422 }))
    const withStatus = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(withStatus.attempts?.[0]?.status).toBe(422)

    const f2 = fixture({ fallback: false })
    f2.p1.nextReject(new ProviderError('invalid_request'))
    const withoutStatus = await expectCode(f2.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(withoutStatus.attempts?.[0]).not.toHaveProperty('status')
  })
})

describe('crossed origins — the origin decides, never the thrown class', () => {
  it('propagates a branded ProviderError from the stage-2 input transform, unwrapped', async () => {
    const branded = new ProviderError('rate_limit', { status: 429 })
    const operations = {
      echo: {
        input: z.object({ text: z.string() }).transform(() => {
          throw branded
        }),
        output: ECHO_OUTPUT,
        prompt: () => 'p',
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    await expectSameRejection(f.ai.run('echo', INPUT), branded)
  })

  it('propagates a branded ProviderError from the prompt callback, unwrapped', async () => {
    const branded = new ProviderError('transient')
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT,
        prompt: () => {
          throw branded
        },
        defaultRoute: { provider: 'p1', model: 'm1' },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    await expectSameRejection(f.ai.run('echo', INPUT), branded)
  })

  it('propagates a branded ProviderError from the output transform, unwrapped', async () => {
    const branded = new ProviderError('transient')
    const operations = {
      echo: {
        input: ECHO_INPUT,
        output: ECHO_OUTPUT.transform(() => {
          throw branded
        }),
        prompt: () => 'p',
        defaultRoute: {
          provider: 'p1',
          model: 'm1',
          fallback: { provider: 'p2', model: 'm2' },
        },
      },
    } as unknown as OperationsMap
    const f = fixture({ operations })
    await expectSameRejection(f.ai.run('echo', INPUT), branded)
    expect(f.p2.requests.length).toBe(0) // output_schema_error: no fallback for a user bug
  })

  it('propagates a branded ProviderError from the quality gate, unwrapped', async () => {
    const branded = new ProviderError('rate_limit')
    const f = fixture({
      quality: () => {
        throw branded
      },
    })
    await expectSameRejection(f.ai.run('echo', INPUT), branded)
  })

  it('wraps a plain error thrown by complete() as provider_unclassified, never unwrapped', async () => {
    const plain = new Error('adapter bug')
    const f = fixture({ fallback: false })
    f.p1.nextReject(plain)
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error).not.toBe(plain)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['provider_unclassified'])
  })

  it('wraps a ZodError thrown by complete() the same way — origin, not class', async () => {
    let zodError: unknown
    try {
      z.string().parse(42)
    } catch (error) {
      zodError = error
    }
    const f = fixture({ fallback: false })
    f.p1.nextReject(zodError)
    const error = await expectCode(f.ai.run('echo', INPUT), 'PROVIDER_FAILED')
    expect(error).not.toBe(zodError)
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['provider_unclassified'])

    const f2 = fixture({ config: { treatUnclassifiedAsTransient: true } })
    f2.p1.nextReject(zodError)
    const rescued = await f2.ai.run('echo', INPUT)
    expect(rescued.attempts.map((a) => a.outcome)).toEqual(['transient', 'succeeded'])
  })
})

describe('detectedAt discipline on the final attempt', () => {
  it('sets provider only when the terminal code is INVALID_CONFIG from the final attempt', async () => {
    const f = fixture({ config: { fallbackOnAuthOrModelNotFound: true } })
    f.p1.nextReject(new ProviderError('transient'))
    f.p2.nextReject(new ProviderError('auth', { status: 401 }))
    const error = await expectCode(f.ai.run('echo', INPUT), 'INVALID_CONFIG')
    expect(error.detectedAt).toBe('provider')
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['transient', 'auth'])
  })

  it('lets a later caller abort win over the attempt-determined code', async () => {
    const f = fixture({ fallback: false })
    const controller = new AbortController()
    f.p1.next(() => {
      controller.abort() // fires while the auth failure is on its way back
      throw new ProviderError('auth', { status: 401 })
    })
    const error = await expectCode(
      f.ai.run('echo', INPUT, { signal: controller.signal }),
      'ABORTED',
    )
    expect(error.detectedAt).toBeUndefined()
    expect(error.attempts?.map((a) => a.outcome)).toEqual(['aborted'])
  })
})

describe('user-error rows settle before the raw throw', () => {
  it('output_schema_error and quality_error settle first (order observed)', async () => {
    const order: string[] = []
    const bug = new Error('quality bug')
    const f = fixture({
      quota: { perDay: 5 },
      quality: () => {
        throw bug
      },
    })
    f.s.settle.next(() => {
      order.push('settle')
      return undefined
    })
    const run = observe(
      f.ai.run('echo', { ...INPUT, subjectId: 'u' }).catch((error: unknown) => {
        order.push('thrown')
        throw error
      }),
    )
    await flushMicrotasks()
    expect(run.state).toBe('rejected')
    expect(order).toEqual(['settle', 'thrown'])
  })
})
