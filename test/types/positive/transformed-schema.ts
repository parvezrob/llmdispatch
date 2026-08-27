// @targets spec, package
// A schema that transforms, which is where the three sides of an operation are easiest to
// get wrong: `run` takes what the caller writes (`z.input`), while `prompt`, `quality` and
// `result.data` all see what the schema produced (`z.output`).
import { createSwitch, defineOperation, defineOperations, memoryStores } from 'llmdispatch'
import { z } from 'zod'

const ai = createSwitch({
  providers: {},
  operations: defineOperations({
    wordcount: defineOperation({
      input: z.object({ text: z.string().transform((value) => value.split(' ')) }),
      output: z.object({ total: z.string().transform((value) => Number(value)) }),
      // `text` arrives as the transformed value, not as the string the caller passed.
      prompt: ({ text }) => `Count the words in ${String(text.length)} tokens.`,
      quality: ({ input, data }) =>
        data.total === input.text.length ? { ok: true } : { ok: false },
    }),
  }),
  stores: memoryStores(),
})

// The caller writes a string…
const result = await ai.run('wordcount', { input: { text: 'one two three' } })

// …and reads a number back.
export const total: number = result.data.total
