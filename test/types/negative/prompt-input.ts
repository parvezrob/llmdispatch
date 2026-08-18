// @targets spec
// The typo the README promises is a compile error: `prompt` reads a field the input schema
// does not declare.
import { defineOperation, defineOperations } from 'llmswitch'
import { z } from 'zod'

export const operations = defineOperations({
  summarize: defineOperation({
    input: z.object({ text: z.string() }),
    output: z.object({ summary: z.string() }),
    // @expect TS2339
    prompt: ({ txt }) => String(txt),
  }),
})
