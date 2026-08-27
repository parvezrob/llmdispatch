/**
 * Stage 6 normalization (spec §1, §6): a string becomes one text part, a returned array is
 * copied into frozen records the run owns, every §6 part rule is enforced before the
 * reservation of stage 7, and the two user-bug exceptions are the pinned types carrying the
 * pinned facts — never the part data or the filename.
 */

import { describe, expect, it } from 'vitest'

import { LLMDispatchError, ProviderError } from '../../../src/errors'
import {
  MAX_FILE_PAYLOAD_CHARACTERS,
  MAX_FILENAME_LENGTH,
  MAX_PARTS,
  normalizePromptParts,
} from '../../../src/core/parts'
import type { ContentPart, ProviderRequest } from '../../../src/types'
import { fixture, okResponse, ECHO_INPUT, ECHO_OUTPUT } from './helpers'
import type { OperationsMap } from '../../../src/types'

/** Base64 of the given character length, padded the way §6 requires. */
function base64Of(length: number): string {
  return 'A'.repeat(length - 1) + '='
}

const PDF: ContentPart = { type: 'file', mediaType: 'application/pdf', data: 'QUJDRA==' }

/** A fixture whose prompt callback returns exactly `returned`, quota declared. */
function promptReturning(returned: unknown) {
  const operations = {
    echo: {
      input: ECHO_INPUT,
      output: ECHO_OUTPUT,
      prompt: () => returned,
      quota: { perDay: 5 },
      defaultRoute: {
        provider: 'p1',
        model: 'm1',
        fallback: { provider: 'p2', model: 'm2' },
      },
    },
  } as unknown as OperationsMap
  return fixture({ operations })
}

const ARGS = { input: { text: 'hi' }, subjectId: 'u' }

/** Runs `echo` and answers what it threw, or `null` when it resolved. */
async function runToFailure(
  returned: unknown,
): Promise<{ error: unknown; quotaCalls: number }> {
  const f = promptReturning(returned)
  let error: unknown = null
  try {
    await f.ai.run('echo', ARGS)
  } catch (caught) {
    error = caught
  }
  return { error, quotaCalls: f.s.reserve.calls.length }
}

describe('normalizing what the prompt callback returned', () => {
  it('turns a string into exactly one text part', () => {
    expect(normalizePromptParts('hello', 'echo')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('accepts the empty string, which is a legal prompt', () => {
    expect(normalizePromptParts('', 'echo')).toEqual([{ type: 'text', text: '' }])
  })

  it('keeps a returned array in order and drops fields no part declares', () => {
    const returned = [
      { type: 'text', text: 'look at this', extra: 'ignored' },
      { type: 'file', mediaType: 'image/png', data: 'QUJDRA==', filename: 'chart.png' },
    ]
    expect(normalizePromptParts(returned, 'echo')).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'file', mediaType: 'image/png', data: 'QUJDRA==', filename: 'chart.png' },
    ])
  })

  it('omits an absent filename rather than carrying it as undefined', () => {
    const [part] = normalizePromptParts([PDF], 'echo')
    expect(part).toBeDefined()
    expect('filename' in (part as object)).toBe(false)
  })

  it('accepts every media type the contract names', () => {
    for (const mediaType of [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]) {
      const parts = normalizePromptParts([{ type: 'file', mediaType, data: 'QUJD' }], 'echo')
      expect(parts).toEqual([{ type: 'file', mediaType, data: 'QUJD' }])
    }
  })
})

describe('ownership: the parts a run dispatches are frozen copies', () => {
  it('freezes the array and every part', () => {
    const parts = normalizePromptParts([{ type: 'text', text: 'a' }, PDF], 'echo')
    expect(Object.isFrozen(parts)).toBe(true)
    expect(parts.every((part) => Object.isFrozen(part))).toBe(true)
  })

  it('freezes a file part carrying a filename, which is its own return site', () => {
    const named = { ...PDF, filename: 'statement.pdf' }
    const returned = [{ ...named }]
    const [part] = normalizePromptParts(returned, 'echo')
    expect(Object.isFrozen(part)).toBe(true)
    // Writes through both the copy and the array the callback kept must be inert.
    const writable = part as { data: string; filename: string; mediaType: string }
    for (const write of [
      () => (writable.data = 'QUJDRQ=='),
      () => (writable.filename = 'rewritten.pdf'),
      () => (writable.mediaType = 'image/png'),
    ]) {
      expect(write).toThrow(TypeError)
    }
    returned[0] = { ...named, filename: 'swapped.pdf' }
    expect(part).toEqual(named)
  })

  it('dispatches the same frozen named file part to a fallback attempt', async () => {
    const named = { ...PDF, filename: 'statement.pdf' }
    const f = promptReturning([named])
    f.p1.next((request: ProviderRequest) => {
      const target = request.parts[0] as { data: string; filename: string }
      try {
        target.filename = 'rewritten.pdf'
      } catch {
        /* frozen parts throw in strict mode; either way nothing changes */
      }
      try {
        target.data = 'QUJDRQ=='
      } catch {
        /* same */
      }
      throw new ProviderError('transient')
    })
    f.p2.nextResolve(okResponse())
    await f.ai.run('echo', ARGS)
    expect(f.p2.requests[0]?.parts).toEqual([named])
  })

  it('does not alias the array the callback returned', () => {
    const returned: ContentPart[] = [{ type: 'text', text: 'a' }]
    const parts = normalizePromptParts(returned, 'echo')
    returned.push({ type: 'text', text: 'b' })
    expect(parts).toHaveLength(1)
  })

  it('leaves a fallback attempt unharmed when the primary provider mutates the parts', async () => {
    const f = fixture()
    f.p1.next((request: ProviderRequest) => {
      // A hostile adapter: both writes must be inert, so the fallback sees what stage 6 built.
      try {
        ;(request.parts as ContentPart[]).push({ type: 'text', text: 'appended' })
      } catch {
        /* frozen arrays throw in strict mode; either way nothing changes */
      }
      try {
        ;(request.parts[0] as { text: string }).text = 'rewritten'
      } catch {
        /* same */
      }
      throw new ProviderError('transient')
    })
    await f.ai.run('echo', { input: { text: 'hi' } })
    expect(f.p2.requests[0]?.parts).toEqual([{ type: 'text', text: 'PROMPT:hi' }])
  })

  it('reads each field once, so a second read cannot slip past validation', () => {
    /** A part whose every field answers truthfully once, then lies. */
    function twoFaced(honest: Record<string, unknown>, liar: Record<string, unknown>): object {
      const reads = new Map<string, number>()
      const part = {}
      for (const key of Object.keys(honest)) {
        Object.defineProperty(part, key, {
          enumerable: true,
          get: () => {
            const seen = (reads.get(key) ?? 0) + 1
            reads.set(key, seen)
            return seen === 1 ? honest[key] : liar[key]
          },
        })
      }
      return part
    }

    const [file] = normalizePromptParts(
      [
        twoFaced(
          { type: 'file', mediaType: 'image/png', data: 'QUJD', filename: 'chart.png' },
          { type: 'text', mediaType: 'image/heic', data: 'not base64!', filename: '../x' },
        ),
      ],
      'echo',
    )
    expect(file).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: 'QUJD',
      filename: 'chart.png',
    })

    const [text] = normalizePromptParts(
      [twoFaced({ type: 'text', text: 'honest' }, { type: 'file', text: 42 })],
      'echo',
    )
    expect(text).toEqual({ type: 'text', text: 'honest' })
  })

  it('walks the length it measured, so a growing array cannot append an unchecked part', () => {
    const backing: unknown[] = [
      { type: 'text', text: 'validated' },
      { type: 'file', mediaType: 'image/heic', data: 'not base64!' },
    ]
    let lengthReads = 0
    // Still an array to `Array.isArray`, but it reports one entry until someone looks twice.
    const returned = new Proxy(backing, {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          lengthReads += 1
          return lengthReads > 1 ? 2 : 1
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(normalizePromptParts(returned, 'echo')).toEqual([
      { type: 'text', text: 'validated' },
    ])
  })
})

describe('structural rules, each a descriptive TypeError', () => {
  const cases: { name: string; returned: unknown; rule: RegExp }[] = [
    {
      name: 'a return that is neither string nor array',
      returned: 42,
      rule: /must return a string/,
    },
    { name: 'an empty parts array', returned: [], rule: /empty array/ },
    { name: 'a part that is not an object', returned: ['hello'], rule: /must be an object/ },
    { name: 'a null part', returned: [null], rule: /must be an object/ },
    {
      name: 'an unknown discriminant',
      returned: [{ type: 'audio', data: 'QUJD' }],
      rule: /type must be 'text' or 'file'/,
    },
    {
      name: 'non-string text',
      returned: [{ type: 'text', text: 7 }],
      rule: /text must be a string/,
    },
    {
      name: 'an unknown media type',
      returned: [{ type: 'file', mediaType: 'image/heic', data: 'QUJD' }],
      rule: /mediaType must be one of/,
    },
    {
      name: 'non-string data',
      returned: [{ type: 'file', mediaType: 'image/png', data: 7 }],
      rule: /data must be a string/,
    },
    {
      name: 'empty data',
      returned: [{ type: 'file', mediaType: 'image/png', data: '' }],
      rule: /data must not be empty/,
    },
    {
      name: 'a data-URL prefix',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,QUJD' }],
      rule: /no data-URL prefix/,
    },
    {
      name: 'whitespace inside the payload',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QU JD' }],
      rule: /must not contain whitespace/,
    },
    {
      name: 'a newline inside the payload',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QUJD\nQUJD' }],
      rule: /must not contain whitespace/,
    },
    {
      name: 'a character outside the standard alphabet',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QU-D' }],
      rule: /standard base64 alphabet/,
    },
    {
      name: 'URL-safe base64',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QU_D' }],
      rule: /standard base64 alphabet/,
    },
    {
      name: 'padding away from the end',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QU=D' }],
      rule: /standard base64 alphabet/,
    },
    {
      name: 'three padding characters',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QUJDR===' }],
      rule: /standard base64 alphabet/,
    },
    {
      name: 'a length that is not a multiple of four',
      returned: [{ type: 'file', mediaType: 'image/png', data: 'QUJDR' }],
      rule: /multiple of four/,
    },
    {
      name: 'a non-string filename',
      returned: [{ ...PDF, filename: 7 }],
      rule: /filename must be a string/,
    },
    {
      name: 'an empty filename',
      returned: [{ ...PDF, filename: '' }],
      rule: /filename must not be empty/,
    },
    {
      name: 'a filename one character over the bound',
      returned: [{ ...PDF, filename: 'a'.repeat(MAX_FILENAME_LENGTH + 1) }],
      rule: /filename must be at most 128 characters/,
    },
    {
      name: 'a control character in the filename',
      returned: [{ ...PDF, filename: 'report\u0007.pdf' }],
      rule: /filename must not contain control characters/,
    },
    {
      name: 'a forward slash in the filename',
      returned: [{ ...PDF, filename: 'reports/q3.pdf' }],
      rule: /path separator/,
    },
    {
      name: 'a backslash in the filename',
      returned: [{ ...PDF, filename: 'reports\\q3.pdf' }],
      rule: /path separator/,
    },
  ]

  for (const { name, returned, rule } of cases) {
    it(`rejects ${name}`, () => {
      expect(() => normalizePromptParts(returned, 'echo')).toThrow(TypeError)
      expect(() => normalizePromptParts(returned, 'echo')).toThrow(rule)
    })
  }

  it('accepts a filename exactly at the bound', () => {
    const filename = 'a'.repeat(MAX_FILENAME_LENGTH)
    expect(normalizePromptParts([{ ...PDF, filename }], 'echo')).toEqual([{ ...PDF, filename }])
  })

  it('names the offending part index and the operation', () => {
    expect(() =>
      normalizePromptParts([{ type: 'text', text: 'fine' }, { type: 'audio' }], 'summarize'),
    ).toThrow(/operation "summarize".*index 1/)
  })
})

describe('the part-count cap, a descriptive RangeError', () => {
  /** `count` text parts, the cheapest kind to build a long list from. */
  function textParts(count: number): ContentPart[] {
    return Array.from({ length: count }, (_, index) => ({
      type: 'text' as const,
      text: `part ${String(index)}`,
    }))
  }

  it('admits a request carrying exactly the cap', () => {
    expect(normalizePromptParts(textParts(MAX_PARTS), 'echo')).toHaveLength(MAX_PARTS)
  })

  it('rejects one part over the cap, naming the count, the cap and the operation', () => {
    let caught: unknown
    try {
      normalizePromptParts(textParts(MAX_PARTS + 1), 'summarize')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RangeError)
    const { message } = caught as RangeError
    expect(message).toMatch(/returned 257 content parts, more than the 256 a request may carry/)
    expect(message).toContain('summarize')
  })

  it('counts every part, not only the file ones', () => {
    const parts = [...textParts(MAX_PARTS), PDF]
    expect(() => normalizePromptParts(parts, 'echo')).toThrow(RangeError)
  })
})

describe('the file-payload cap, a descriptive RangeError', () => {
  it('admits a single part exactly at the cap', () => {
    const data = base64Of(MAX_FILE_PAYLOAD_CHARACTERS)
    const parts = normalizePromptParts(
      [{ type: 'file', mediaType: 'application/pdf', data }],
      'echo',
    )
    expect(parts).toHaveLength(1)
  })

  it('rejects a single part one character over the cap', () => {
    const data = base64Of(MAX_FILE_PAYLOAD_CHARACTERS + 4)
    expect(() =>
      normalizePromptParts([{ type: 'file', mediaType: 'application/pdf', data }], 'echo'),
    ).toThrow(RangeError)
  })

  it('admits several parts totalling exactly the cap', () => {
    const half = base64Of(MAX_FILE_PAYLOAD_CHARACTERS / 2)
    const parts = normalizePromptParts(
      [
        { type: 'file', mediaType: 'image/png', data: half },
        { type: 'text', text: 'and this' },
        { type: 'file', mediaType: 'image/png', data: half },
      ],
      'echo',
    )
    expect(parts).toHaveLength(3)
  })

  it('rejects several parts totalling four characters over the cap, naming where it crossed', () => {
    const half = base64Of(MAX_FILE_PAYLOAD_CHARACTERS / 2)
    const over = base64Of(MAX_FILE_PAYLOAD_CHARACTERS / 2 + 4)
    let caught: unknown
    try {
      normalizePromptParts(
        [
          { type: 'file', mediaType: 'image/png', data: half },
          { type: 'file', mediaType: 'image/png', data: over },
        ],
        'echo',
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RangeError)
    expect((caught as RangeError).message).toMatch(/index 1/)
    expect((caught as RangeError).message).toContain('15000000')
  })

  it('does not count text against the file payload', () => {
    const parts = normalizePromptParts(
      [
        { type: 'text', text: 'x'.repeat(MAX_FILE_PAYLOAD_CHARACTERS) },
        { type: 'file', mediaType: 'image/png', data: base64Of(MAX_FILE_PAYLOAD_CHARACTERS) },
      ],
      'echo',
    )
    expect(parts).toHaveLength(2)
  })
})

describe('the stage-6 error contract inside a run', () => {
  it('passes a structural TypeError through unwrapped, before any reservation', async () => {
    const { error, quotaCalls } = await runToFailure([{ type: 'file', mediaType: 'text/csv' }])
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(LLMDispatchError)
    expect(quotaCalls).toBe(0)
  })

  it('passes a cap RangeError through unwrapped, before any reservation', async () => {
    const { error, quotaCalls } = await runToFailure([
      {
        type: 'file',
        mediaType: 'application/pdf',
        data: base64Of(MAX_FILE_PAYLOAD_CHARACTERS + 4),
      },
    ])
    expect(error).toBeInstanceOf(RangeError)
    expect(error).not.toBeInstanceOf(LLMDispatchError)
    expect(quotaCalls).toBe(0)
  })

  it('dispatches a returned parts array to the provider unchanged', async () => {
    const f = promptReturning([{ type: 'text', text: 'describe this' }, PDF])
    f.p1.nextResolve(okResponse())
    await f.ai.run('echo', ARGS)
    expect(f.p1.requests[0]?.parts).toEqual([{ type: 'text', text: 'describe this' }, PDF])
  })
})

describe('no thrown message ever carries part data or a filename', () => {
  const DATA_SENTINEL = 'U0VOVElORUxfREFUQV84YjJm'
  const FILENAME_SENTINEL = 'SENTINEL_FILENAME_4d7e.pdf'

  const provocations: { name: string; returned: unknown; rule?: RegExp }[] = [
    {
      name: 'a bad media type beside good data',
      returned: [{ type: 'file', mediaType: 'image/heic', data: DATA_SENTINEL }],
    },
    {
      name: 'malformed data',
      returned: [{ type: 'file', mediaType: 'image/png', data: `${DATA_SENTINEL}!` }],
    },
    {
      // The sentinel is alphabet-clean, so only the space is wrong and the whitespace rule
      // is the one that reports: the alphabet rule cannot mask it.
      name: 'whitespace inside otherwise valid data',
      returned: [
        {
          type: 'file',
          mediaType: 'image/png',
          data: `${DATA_SENTINEL} ${DATA_SENTINEL}`,
        },
      ],
      rule: /must not contain whitespace/,
    },
    {
      name: 'a rejected filename',
      returned: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          data: DATA_SENTINEL,
          filename: `../${FILENAME_SENTINEL}`,
        },
      ],
    },
    {
      name: 'a control character inside the filename',
      returned: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          data: DATA_SENTINEL,
          filename: `${FILENAME_SENTINEL}\u0007`,
        },
      ],
      rule: /filename must not contain control characters/,
    },
    {
      name: 'a filename over the bound',
      returned: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          data: DATA_SENTINEL,
          filename: FILENAME_SENTINEL.padEnd(MAX_FILENAME_LENGTH + 1, 'z'),
        },
      ],
    },
    {
      name: 'a payload over the cap',
      returned: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          data: DATA_SENTINEL + base64Of(MAX_FILE_PAYLOAD_CHARACTERS),
          filename: FILENAME_SENTINEL,
        },
      ],
    },
  ]

  for (const { name, returned, rule } of provocations) {
    it(`keeps both sentinels out of the message for ${name}`, () => {
      let caught: unknown
      try {
        normalizePromptParts(returned, 'echo')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      // Where the reported rule is the point of the case, prove that rule was the one hit.
      if (rule !== undefined) expect(message).toMatch(rule)
      expect(message).not.toContain(DATA_SENTINEL)
      expect(message).not.toContain(FILENAME_SENTINEL)
    })
  }
})
