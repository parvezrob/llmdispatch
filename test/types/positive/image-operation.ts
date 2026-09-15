// @targets spec, package
// An image operation end to end: the definition's `format: 'image'` with its knobs, the
// packaged `imageOutputSchema` as the output, and a result whose images are dimensioned
// file parts an adopter can hand straight back into a later prompt.
import {
  createSwitch,
  defineOperation,
  defineOperations,
  imageOutputSchema,
  memoryStores,
  type AspectRatio,
  type ContentPart,
  type GeneratedImage,
  type ImageOptions,
  type ImageOutput,
  type ImageSize,
  type ProviderImage,
  type ProviderResponse,
  type TokenUsage,
} from 'llmdispatch'
import { z } from 'zod'

const ratio: AspectRatio = '16:9'
const size: ImageSize = '2K'
const knobs: ImageOptions = { count: 4, aspectRatio: ratio, size, background: 'transparent' }

const operations = defineOperations({
  artwork: defineOperation({
    input: z.object({ subject: z.string() }),
    output: imageOutputSchema,
    prompt: ({ subject }) => `a flat vector illustration of ${subject}`,
    format: 'image',
    image: knobs,
    quality: ({ data }) => ({ ok: data.images.every((image) => image.width >= 1024) }),
  }),
  // A stricter adopter schema still satisfies the operation's output slot.
  poster: defineOperation({
    input: z.object({ subject: z.string() }),
    output: imageOutputSchema.refine((output) => output.images.length === 1),
    prompt: ({ subject }) => subject,
    format: 'image',
  }),
})

const ai = createSwitch({
  providers: {},
  operations,
  stores: memoryStores(),
  pricing: { p: { m: { inputPerM: 1, outputPerM: 2, imageOutputPerM: 40 } } },
})

export async function pick(subject: string): Promise<GeneratedImage> {
  const result = await ai.run('artwork', { input: { subject }, subjectId: 'u' })
  const output: ImageOutput = result.data
  const [first] = output.images
  if (first === undefined) throw new Error('unreachable: the schema requires one image')
  const width: number = first.width
  const height: number = first.height
  void [width, height]
  // A generated image is a file part: it goes back into a prompt without conversion.
  const parts: readonly ContentPart[] = [{ type: 'text', text: 'refine this' }, first]
  void parts
  const usage: TokenUsage = result.usage
  const split: number | undefined = usage.imageOutputTokens
  void split
  return first
}

/** What an adapter answers: dimensions both stated or both left to the core. */
export function answer(data: string): ProviderResponse {
  const stated: ProviderImage = { mediaType: 'image/png', data, width: 1024, height: 1024 }
  const bare: ProviderImage = { mediaType: 'image/webp', data }
  return {
    kind: 'complete',
    text: '',
    images: [stated, bare],
    usage: { inputTokens: 10, outputTokens: 1290, imageOutputTokens: 1280 },
    costUsd: 0.04,
  }
}
