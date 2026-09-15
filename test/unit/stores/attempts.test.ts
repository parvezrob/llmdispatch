/**
 * The attempt projection every store applies (spec §4, §7): exactly the persisted fields,
 * with the optional image split copied only when the record carries it.
 */

import { describe, expect, it } from 'vitest'

import { projectAttempts } from '../../../src/stores/shared/attempts'
import type { AttemptRecord } from '../../../src/types'

const BASE: AttemptRecord = {
  provider: 'p',
  model: 'm',
  outcome: 'succeeded',
  usage: { inputTokens: 3, outputTokens: 2 },
  costUsd: null,
  durationMs: 10,
}

describe('projectAttempts', () => {
  it('copies the split when present and leaves the key absent otherwise', () => {
    const [withSplit, without] = projectAttempts([
      { ...BASE, usage: { inputTokens: 3, outputTokens: 2, imageOutputTokens: 2 } },
      BASE,
    ])
    expect(withSplit?.usage).toEqual({ inputTokens: 3, outputTokens: 2, imageOutputTokens: 2 })
    expect(without?.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(without?.usage).not.toHaveProperty('imageOutputTokens')
  })

  it('drops everything outside the persisted fields', () => {
    const [record] = projectAttempts([
      {
        ...BASE,
        status: 200,
        prompt: 'secret',
        usage: { inputTokens: 1, outputTokens: 1, raw: {} },
      } as never,
    ])
    expect(record).toEqual({ ...BASE, status: 200, usage: { inputTokens: 1, outputTokens: 1 } })
  })
})
