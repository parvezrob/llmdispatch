// @targets spec, package
// An svg operation end to end: the definition's `format: 'svg'` with its knobs, the
// packaged `svgOutputSchema` as the output, and a result whose documents are base64 an
// adopter decodes and hands to a sanitizer or a rasterizer, never straight to a page.
import {
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  svgOutputSchema,
  type AspectRatio,
  type GeneratedSvg,
  type ProviderResponse,
  type ProviderSvg,
  type SvgOptions,
  type SvgOutput,
} from 'llmdispatch'
import { z } from 'zod'

const ratio: AspectRatio = '3:4'
const knobs: SvgOptions = { count: 2, aspectRatio: ratio }

const operations = defineOperations({
  artwork: defineOperation({
    input: z.object({ subject: z.string() }),
    output: svgOutputSchema,
    prompt: ({ subject }) => `a flat vector illustration of ${subject}`,
    format: 'svg',
    svg: knobs,
    quality: ({ data }) => ({ ok: data.svgs.every((svg) => svg.data.length > 0) }),
  }),
  // A stricter adopter schema still satisfies the operation's output slot.
  logo: defineOperation({
    input: z.object({ subject: z.string() }),
    output: svgOutputSchema.refine((output) => output.svgs.length === 1),
    prompt: ({ subject }) => subject,
    format: 'svg',
  }),
})

const ai = createSwitch({ providers: {}, operations, stores: memoryStores() })

export async function pick(subject: string): Promise<GeneratedSvg> {
  const result = await ai.run('artwork', { input: { subject }, subjectId: 'u' })
  const output: SvgOutput = result.data
  const [first] = output.svgs
  if (first === undefined) throw new Error('unreachable: the schema requires one document')
  return first
}

/** A generated document is told apart from a file part by its type. */
export function isSvg(value: GeneratedSvg | { type: 'file' }): value is GeneratedSvg {
  return value.type === 'svg'
}

/** What an adapter answers: the documents, base64, with the one media type. */
export function answer(data: string): ProviderResponse {
  const svg: ProviderSvg = { mediaType: 'image/svg+xml', data }
  return { kind: 'complete', text: '', svgs: [svg], usage: null, costUsd: 0.08 }
}
