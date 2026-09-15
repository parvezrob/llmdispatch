/**
 * The ready-made output schema for an image operation, and the shapes and bounds the §3
 * image sub-stage reads a response against (spec §3, §6).
 *
 * `imageOutputSchema` is declared as `z.ZodType<ImageOutput>` so the published surface
 * carries the interface, not the schema's inferred internals. Refine it for anything
 * stricter than "well-formed". The media types and the two response caps live here rather
 * than in `run.ts` because the adapters keep copies of them and a test holds the copies to
 * these; only `imageOutputSchema` is exported from the package.
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

/**
 * §3 point 4b: how many images one response may carry, whatever the operation asked for.
 *
 * Deliberately above `MAX_IMAGE_COUNT` in `create-switch.ts`: that is the knob an operation
 * may ask for, this is a payload bound on what came back. One provider candidate may carry
 * several images for a single requested one, so a ceiling at the knob would reject a paid
 * run for answering generously.
 */
export const MAX_RESPONSE_IMAGES = 32

/** §3 point 4b: the per-image response ceiling, in base64 characters (22.5 MB decoded). */
export const MAX_RESPONSE_IMAGE_CHARACTERS = 30_000_000

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
