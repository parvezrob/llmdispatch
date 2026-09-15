/**
 * The ready-made output schema for an image operation (spec §3, §6).
 *
 * Declared as `z.ZodType<ImageOutput>` so the published surface carries the interface, not
 * the schema's inferred internals. Refine it for anything stricter than "well-formed".
 *
 * @module
 */

import { z } from 'zod'
import type { GeneratedImageMediaType, ImageOutput } from '../types'

/** The three raster types a generated image may carry (spec §6). */
export const IMAGE_MEDIA_TYPES: readonly GeneratedImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
]

const generatedImage = z.object({
  type: z.literal('file'),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

/**
 * Accepts exactly what the §3 image sub-stage produces: at least one well-formed image and
 * the text beside it. The one-image case is the default; `imageOutputSchema.refine(...)`
 * adds a count or a dimension floor.
 */
export const imageOutputSchema: z.ZodType<ImageOutput> = z.object({
  images: z.array(generatedImage).min(1),
  text: z.string(),
})
