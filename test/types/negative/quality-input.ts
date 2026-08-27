// @targets spec, package
// The other half of the same rule: `input` in a quality gate is the input schema's parsed
// type, not whatever the caller happened to pass.
import { defineOperation, defineOperations } from 'llmdispatch'
import { z } from 'zod'

export const operations = defineOperations({
  summarize: defineOperation({
    input: z.object({ text: z.string() }),
    output: z.object({ summary: z.string() }),
    prompt: ({ text }) => text,
    // @expect TS2339
    quality: ({ input }) => (input.article === '' ? { ok: false } : { ok: true }),
  }),
})
