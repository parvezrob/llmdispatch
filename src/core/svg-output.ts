/**
 * The §3 svg sub-stage (spec §3 point 4c, §6): from a complete response's `svgs` to owned,
 * frozen `GeneratedSvg`s, and the ready-made output schema for an svg operation.
 *
 * Its own module rather than a branch of `image-output.ts`: the raster stage reads a
 * header, the vector stage runs the document check, and they share no cap, media type or
 * output shape. Kept out of `run.ts` so the stage and its caps can be tested on their own.
 * Only `svgOutputSchema` is exported from the package.
 *
 * @module
 */

import { z } from 'zod'
import type { GeneratedSvg, SvgOutput } from '../types'
import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
  svgDocumentProblem,
} from './svg-document'
import { isCount, isRecord } from './validate'

/** The one media type a generated SVG document carries (spec §6). */
export const SVG_MEDIA_TYPE = 'image/svg+xml'

/**
 * Normalizes a complete response's `svgs` into owned, frozen `GeneratedSvg`s (§3 point 4c),
 * or `null` for any failure, which the caller classifies `malformed_response`. Absent counts
 * as none.
 *
 * Every bound comes before any decode: the count before any element is read, then, element
 * by element, each one's `data` length and the running total across the response, so an
 * oversized payload costs length reads rather than a scan. Only then is each document run
 * through the document check, one at a time and in order. Each element is read once.
 */
export function readSvgs(value: unknown): readonly GeneratedSvg[] | null {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) return null
  // Length once, then indexed reads: an overridden iterator cannot yield a sequence other
  // than the one validated, and nothing is copied before element 0 has been checked.
  const length: unknown = (value as unknown[]).length
  if (!isCount(length) || length > MAX_RESPONSE_SVGS) return null
  const documents: string[] = []
  let total = 0
  for (let index = 0; index < length; index++) {
    const element: unknown = (value as unknown[])[index]
    if (!isRecord(element)) return null
    const { mediaType, data } = element
    if (typeof data !== 'string' || data.length > MAX_SVG_CHARACTERS) return null
    total += data.length
    if (total > MAX_RESPONSE_SVG_CHARACTERS) return null
    if (mediaType !== SVG_MEDIA_TYPE) return null
    documents.push(data)
  }
  const svgs: GeneratedSvg[] = []
  for (const data of documents) {
    if (svgDocumentProblem(data) !== null) return null
    svgs.push(Object.freeze({ type: 'svg', mediaType: SVG_MEDIA_TYPE, data }))
  }
  return Object.freeze(svgs)
}

const generatedSvg = z.object({
  type: z.literal('svg'),
  mediaType: z.literal(SVG_MEDIA_TYPE),
  data: z.string().min(1),
})

/**
 * Accepts exactly what the §3 svg sub-stage produces: at least one document and the text
 * beside it. It is the schema of the core's already-normalized output, not an SVG parser,
 * sanitizer or validator of a provider's response: it checks shape only, and the document
 * check has run before it sees anything. `svgOutputSchema.refine(...)` adds a count.
 */
export const svgOutputSchema: z.ZodType<SvgOutput> = z.object({
  svgs: z.array(generatedSvg).min(1),
  text: z.string(),
})
