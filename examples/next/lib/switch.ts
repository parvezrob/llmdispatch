import {
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  openaiCompatible,
} from 'llmswitch'
import { z } from 'zod'

/** The body `POST /api/summarize` accepts, checked before the switch ever sees it. */
export const SummarizeBody = z.object({ text: z.string().max(50_000) })

/**
 * One switch for the whole server. Credentials and endpoints are registered here, in
 * code; `OPENAI_BASE_URL` is left unset against the real host and pointed elsewhere for
 * any OpenAI-compatible endpoint, a local model server included.
 */
export const ai = createSwitch({
  providers: {
    openai: openaiCompatible({
      apiKey: () => process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL === undefined
        ? {}
        : { baseUrl: process.env.OPENAI_BASE_URL }),
    }),
  },

  operations: defineOperations({
    summarize: defineOperation({
      input: SummarizeBody,
      output: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }),
      prompt: ({ text }) =>
        `Summarize the following article as JSON with "summary" and "keyPoints".\n\n${text}`,
      quota: { perDay: 100 },
      defaultRoute: { provider: 'openai', model: 'gpt-4.1-mini' },
    }),
  }),

  stores: memoryStores(),
})
