// @targets spec, package
// `run` accepts the input schema's `z.input`, so a wrongly typed field is caught at the
// call site rather than by the parse at stage 2.
import { createSwitch, defineOperation, defineOperations, memoryStores } from 'llmdispatch'
import { z } from 'zod'

const ai = createSwitch({
  providers: {},
  operations: defineOperations({
    summarize: defineOperation({
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
      prompt: ({ text }) => text,
    }),
  }),
  stores: memoryStores(),
})

// @expect TS2322
export const pending = ai.run('summarize', { input: { text: 123 } })
