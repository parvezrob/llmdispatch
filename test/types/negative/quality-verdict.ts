// @targets spec
// A quality gate answers `{ ok: true }` or `{ ok: false, reason? }`. Anything else is a
// malformed verdict, and the type system says so before a run ever can.
import { defineOperation, defineOperations } from 'llmswitch'
import { z } from 'zod'

export const operations = defineOperations({
  summarize: defineOperation({
    input: z.object({ text: z.string() }),
    output: z.object({ summary: z.string() }),
    prompt: ({ text }) => text,
    // @expect TS2322
    quality: () => ({ ok: 'yes' }),
  }),
})
