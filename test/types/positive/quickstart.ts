// @targets spec, package
// The README quickstart, compiled as it is printed there. If the inference ever stops
// working — a schema that no longer reaches `prompt`, a `run` that no longer types its
// input — the README is wrong, and this is where that shows up.
import {
  createSwitch,
  defineOperation,
  defineOperations,
  anthropic,
  openaiCompatible,
  memoryStores,
} from 'llmswitch'
import { z } from 'zod'

const ai = createSwitch({
  // 1. Register providers in code. Credentials and endpoints live HERE,
  //    never in runtime config or the database.
  providers: {
    claude: anthropic({ apiKey: () => process.env.ANTHROPIC_API_KEY }),
    openai: openaiCompatible({ apiKey: () => process.env.OPENAI_API_KEY }),
  },

  // 2. Declare operations: typed input, expected output, and how to build the prompt.
  //    Wrap each operation in defineOperation — that's what ties your schemas to your
  //    callbacks, so a typo inside `prompt` is a compile error, not a runtime surprise.
  operations: defineOperations({
    summarize: defineOperation({
      input: z.object({ text: z.string().max(50_000) }),
      output: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }),
      prompt: ({ text }) =>
        `Summarize the following article as JSON with "summary" and "keyPoints".\n\n${text}`,
      quota: { perDay: 10 },
      // Used when the config store has no row for this operation (bootstrap-friendly).
      defaultRoute: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        fallback: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
    }),
  }),

  // 3. Wire storage: runtime config (routes and limits) + quota counters.
  //    Memory for dev, Postgres for prod.
  stores: memoryStores(),
})

const result = await ai.run('summarize', {
  input: { text: articleText },
  subjectId: user.id, // required whenever the operation has an effective quota
})

// The result fields, with the types the README claims for them.
export const data: { summary: string; keyPoints: string[] } = result.data
export const route: { provider: string; model: string } = result.route
export const usedFallback: boolean = result.usedFallback
export const attempts: number = result.attempts.length
export const usage: { inputTokens: number; outputTokens: number } = result.usage
export const usageComplete: boolean = result.usageComplete
export const cost: number | null = result.cost
