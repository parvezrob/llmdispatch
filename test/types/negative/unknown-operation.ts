// @targets spec, package
// Operation names are typed: a misspelt one does not compile, which is why INVALID_INPUT
// for an unknown name is documented as a JavaScript caller's failure.
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

// @expect TS2345
export const pending = ai.run('sumarize', { input: { text: 'hello' } })
