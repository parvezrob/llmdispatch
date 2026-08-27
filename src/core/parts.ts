/**
 * Stage 6's prompt normalization: whatever the callback returned becomes the frozen
 * `ContentPart[]` every attempt of the run dispatches (spec §1 stage 6, §6).
 *
 * Pure and total: it answers owned records or throws the user-bug exception §6 pins, a
 * `TypeError` for a structural problem and a `RangeError` for the payload cap. No message
 * carries part data or a filename, which are payload like prompt text (spec §4).
 *
 * @module
 */

import type { ContentPart, FilePart, TextPart } from '../types'
import { isRecord } from './validate'

/** The §6 file-payload ceiling, in base64 characters, per part and across all file parts. */
export const MAX_FILE_PAYLOAD_CHARACTERS = 15_000_000

/** The §6 bound on `FilePart.filename`. */
export const MAX_FILENAME_LENGTH = 128

const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+$/
const TRAILING_PADDING = /={1,2}$/
const WHITESPACE = /\s/
// eslint-disable-next-line no-control-regex -- C0, DEL and C1 are exactly what is rejected
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

function invalidPart(operation: string, index: number, rule: string): TypeError {
  return new TypeError(
    `the prompt callback for operation "${operation}" returned an invalid content part at index ${String(index)}: ${rule}`,
  )
}

/** Why `data` is not §6 base64, or `null` when it is. */
function base64Problem(data: unknown): string | null {
  if (typeof data !== 'string') return 'data must be a string'
  if (data === '') return 'data must not be empty'
  if (data.startsWith('data:')) return 'data must be raw base64 with no data-URL prefix'
  if (WHITESPACE.test(data)) return 'data must not contain whitespace'
  if (!BASE64_ALPHABET.test(data.replace(TRAILING_PADDING, ''))) {
    return "data must use the standard base64 alphabet, with '=' only as one or two trailing padding characters"
  }
  if (data.length % 4 !== 0) return 'data must be padded to a multiple of four characters'
  return null
}

/** Why `filename` is not a §6 filename, or `null` when it is (absent counts as valid). */
function filenameProblem(filename: unknown): string | null {
  if (filename === undefined) return null
  if (typeof filename !== 'string') return 'filename must be a string'
  if (filename.length > MAX_FILENAME_LENGTH) {
    return `filename must be at most ${String(MAX_FILENAME_LENGTH)} characters`
  }
  if (CONTROL_CHARACTER.test(filename)) return 'filename must not contain control characters'
  if (filename.includes('/') || filename.includes('\\')) {
    return 'filename must not contain a path separator'
  }
  return null
}

/**
 * Validates one part and answers the owned copy the run will dispatch.
 *
 * Every field is read exactly once, into a local: a getter-backed property must not be able
 * to pass validation and then hand the copy something else.
 */
function ownPart(operation: string, index: number, raw: unknown): ContentPart {
  if (!isRecord(raw)) throw invalidPart(operation, index, 'a part must be an object')
  const type = raw.type
  if (type === 'text') {
    const text = raw.text
    if (typeof text !== 'string') {
      throw invalidPart(operation, index, 'text must be a string')
    }
    const part: TextPart = { type: 'text', text }
    return Object.freeze(part)
  }
  if (type !== 'file') {
    throw invalidPart(operation, index, "type must be 'text' or 'file'")
  }
  const mediaType = raw.mediaType
  const data = raw.data
  const filename = raw.filename
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) {
    throw invalidPart(
      operation,
      index,
      `mediaType must be one of ${[...MEDIA_TYPES].join(', ')}`,
    )
  }
  const dataProblem = base64Problem(data)
  if (dataProblem !== null) throw invalidPart(operation, index, dataProblem)
  const nameProblem = filenameProblem(filename)
  if (nameProblem !== null) throw invalidPart(operation, index, nameProblem)
  const part: FilePart = {
    type: 'file',
    mediaType: mediaType as FilePart['mediaType'],
    data: data as string,
  }
  if (filename !== undefined) {
    return Object.freeze({ ...part, filename: filename as string })
  }
  return Object.freeze(part)
}

/**
 * Normalizes what stage 6's prompt callback returned into the request's content parts.
 *
 * A string becomes one text part; an array is copied part by part into records this run
 * owns, so a retained caller array or a mutating provider cannot move what a later attempt
 * dispatches. Every part and the array itself come back frozen.
 *
 * @param returned What the callback resolved with, unvalidated.
 * @param operation The operation being run, named in every message.
 * @returns The frozen, non-empty parts for the run's `ProviderRequest`s.
 * @throws `TypeError` when the return or a part is structurally wrong, `RangeError` when
 *   the file parts exceed the §6 payload cap. Both are user bugs and pass through unwrapped.
 */
export function normalizePromptParts(
  returned: unknown,
  operation: string,
): readonly ContentPart[] {
  if (typeof returned === 'string') {
    return Object.freeze([Object.freeze<TextPart>({ type: 'text', text: returned })])
  }
  if (!Array.isArray(returned)) {
    throw new TypeError(
      `the prompt callback for operation "${operation}" must return a string or an array of content parts; it returned a value of type ${typeof returned}`,
    )
  }
  // Length once, then indexed reads: an overridden iterator must not be able to yield a
  // sequence other than the one that was validated.
  const length: number = returned.length
  if (length === 0) {
    throw new TypeError(
      `the prompt callback for operation "${operation}" returned an empty array of content parts`,
    )
  }
  const parts: ContentPart[] = []
  // The per-part ceiling and the total are the same number (§6), so the running total
  // enforces both, and reports the part the payload crossed the cap at.
  let payload = 0
  for (let index = 0; index < length; index += 1) {
    const part = ownPart(operation, index, (returned as readonly unknown[])[index])
    if (part.type === 'file') {
      payload += part.data.length
      if (payload > MAX_FILE_PAYLOAD_CHARACTERS) {
        throw new RangeError(
          `the prompt callback for operation "${operation}" returned more than ${String(MAX_FILE_PAYLOAD_CHARACTERS)} base64 characters of file data, reached at content part index ${String(index)}`,
        )
      }
    }
    parts.push(part)
  }
  return Object.freeze(parts)
}
