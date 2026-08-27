// @targets spec, package
// Multimodal prompts type-check: a callback may return a string or a parts array, and the
// parts an adapter receives are readonly all the way down, so the declarations alone prove
// a provider cannot be handed something it may rewrite.
import {
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  ProviderError,
  type ContentPart,
  type FilePart,
  type Provider,
  type TextPart,
} from 'llmdispatch'
import { z } from 'zod'

const page: FilePart = {
  type: 'file',
  mediaType: 'application/pdf',
  data: 'QUJDRA==',
  filename: 'statement.pdf',
}
const instruction: TextPart = { type: 'text', text: 'summarize the statement' }

/** Reading parts is all an adapter needs, and reading is all the type allows. */
function describeParts(parts: readonly ContentPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : part.mediaType)).join(' + ')
}

const custom: Provider = {
  complete: (req) =>
    Promise.resolve({
      kind: 'complete' as const,
      text: `{"summary": ${JSON.stringify(describeParts(req.parts))}}`,
      usage: null,
    }),
}

const ai = createSwitch({
  providers: { custom },
  operations: defineOperations({
    // A parts array, built from the operation's own input.
    read: defineOperation({
      input: z.object({ data: z.string() }),
      output: z.object({ summary: z.string() }),
      prompt: ({ data }): readonly ContentPart[] => [
        instruction,
        { type: 'file', mediaType: 'image/png', data },
      ],
      defaultRoute: { provider: 'custom', model: 'internal' },
    }),
    // A promise of parts, which stage 6 awaits like any other.
    readAsync: defineOperation({
      input: z.object({ data: z.string() }),
      output: z.object({ summary: z.string() }),
      prompt: ({ data }) =>
        Promise.resolve([{ type: 'file' as const, mediaType: 'image/webp' as const, data }]),
      defaultRoute: { provider: 'custom', model: 'internal' },
    }),
    // A plain string still compiles, unchanged from the text-only contract.
    ask: defineOperation({
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
      prompt: ({ text }) => text,
      defaultRoute: { provider: 'custom', model: 'internal' },
    }),
  }),
  stores: memoryStores(),
})

void ProviderError

const result = await ai.run('read', { input: { data: page.data } })
export const summary: string = result.data.summary
export const description: string = describeParts([instruction, page])
