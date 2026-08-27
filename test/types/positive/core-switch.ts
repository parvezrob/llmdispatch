// @targets spec, package
// The core surface without any built-in adapter: a switch assembled from an in-fixture
// custom provider compiles against the published declarations alone, which is what proves
// the decision layer's exports stand on their own before the adapters ship.
import {
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  ProviderError,
  type ContentPart,
  type Provider,
} from 'llmdispatch'
import { z } from 'zod'

/** The one text part a string-returning prompt callback normalizes to. */
function textOf(parts: readonly ContentPart[]): string {
  const first = parts[0]
  return first?.type === 'text' ? first.text : ''
}

const custom: Provider = {
  prepare() {
    return {
      complete: (req) =>
        Promise.resolve({
          kind: 'complete' as const,
          text: `{"length": ${String(textOf(req.parts).length)}}`,
          usage: null,
        }),
    }
  },
  complete() {
    return Promise.reject(new ProviderError('transient'))
  },
}

const ai = createSwitch({
  providers: { custom },
  operations: defineOperations({
    measure: defineOperation({
      input: z.object({ text: z.string() }),
      output: z.object({ length: z.number() }),
      prompt: ({ text }) => text,
      quota: { perDay: 100 },
      defaultRoute: { provider: 'custom', model: 'internal' },
    }),
  }),
  stores: memoryStores(),
})

const result = await ai.run('measure', { input: { text: 'count me' }, subjectId: 'subject' })

// The output schema's type flows through to the caller.
export const length: number = result.data.length
export const fallback: boolean = result.usedFallback
