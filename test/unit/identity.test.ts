import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineOperation, defineOperations } from '../../src/index'

describe('the inference builders', () => {
  // Spec §6: defineOperations is an identity collector: it returns exactly the object it
  // was given, and defineOperation is the per-entry identity that carries the inference.
  it('defineOperations returns the very object it was handed', () => {
    const operations = {
      summarize: defineOperation({
        input: z.object({ text: z.string() }),
        output: z.object({ summary: z.string() }),
        prompt: ({ text }) => text,
      }),
    }
    expect(Object.is(defineOperations(operations), operations)).toBe(true)
  })

  it('defineOperation returns the very definition it was handed', () => {
    const definition = {
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
      prompt: ({ text }: { text: string }) => text,
    }
    expect(Object.is(defineOperation(definition), definition)).toBe(true)
  })
})
