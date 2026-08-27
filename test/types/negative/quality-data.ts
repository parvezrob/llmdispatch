// @targets spec, package
// The quality gate sees the output schema's type, so a field that schema does not declare
// cannot be read from `data`.
import { defineOperation, defineOperations } from 'llmdispatch'
import { z } from 'zod'

export const operations = defineOperations({
  summarize: defineOperation({
    input: z.object({ text: z.string() }),
    output: z.object({ summary: z.string() }),
    prompt: ({ text }) => text,
    // @expect TS2339
    quality: ({ data }) => (data.wordCount === 0 ? { ok: false } : { ok: true }),
  }),
})
