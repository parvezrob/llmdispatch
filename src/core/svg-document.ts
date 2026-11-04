/**
 * The SVG document check (spec §6, SVG document check) and the bounds the §3 svg sub-stage
 * reads a response against (spec §3 point 4c).
 *
 * Pure and dependency-free: the base64 is decoded by hand and the UTF-8 validated by hand,
 * because the core imports no Node built-in and a replacement-character decoder would let
 * invalid bytes through. Everything runs over bytes, never over a decoded string, and the
 * scan stops where the root element starts. The check establishes an SVG-rooted UTF-8
 * document with no DTD; it is not an XML parser and not a sanitizer.
 *
 * @module
 */

import { base64Problem } from './parts'

/**
 * §3 point 4c: how many SVG documents one response may carry, whatever the operation asked
 * for. Deliberately above the `svg.count` knob's 10, for the reason the raster count cap
 * sits above `image.count`: a payload bound on what came back, not a restatement of the
 * request.
 */
export const MAX_RESPONSE_SVGS = 16

/** §3 point 4c: the per-document response ceiling, in base64 characters (7.5 MB decoded). */
export const MAX_SVG_CHARACTERS = 10_000_000

/**
 * §3 point 4c: the ceiling across every document of one response, in base64 characters
 * (30 MB decoded). Each document is still decoded and checked one at a time.
 */
export const MAX_RESPONSE_SVG_CHARACTERS = 40_000_000

/**
 * Why a document failed the check: its base64, its UTF-8 (NUL and a UTF-16 byte order mark
 * included), a malformed XML declaration or comment in the prolog, or a first token that is
 * not the exact `<svg` root (a DOCTYPE, any other `<!` or processing instruction, text, or
 * another element).
 */
export type SvgDocumentProblem = 'base64' | 'encoding' | 'prolog' | 'root'

const BASE64_VALUE = new Int8Array(128).fill(-1)
for (let i = 0; i < 64; i++) {
  BASE64_VALUE[
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)
  ] = i
}

const LESS_THAN = 0x3c
const GREATER_THAN = 0x3e
const QUESTION = 0x3f
const SLASH = 0x2f
const EQUALS = 0x3d
const HYPHEN = 0x2d
const DOUBLE_QUOTE = 0x22
const SINGLE_QUOTE = 0x27

/**
 * Checks one generated SVG document (spec §6), in order: the §6 base64 grammar over the
 * whole string, then a whole decode, strict UTF-8 over every byte, the prolog, and the root.
 *
 * @param data The document as base64, its length already capped by the caller.
 * @returns `null` for a document that passes, else the first rule it broke. Never the bytes.
 */
export function svgDocumentProblem(data: unknown): SvgDocumentProblem | null {
  if (base64Problem(data) !== null) return 'base64'
  const bytes = decodeBase64(data as string)
  if (!isStrictUtf8(bytes)) return 'encoding'
  const root = endOfProlog(bytes)
  if (root === null) return 'prolog'
  return isSvgRoot(bytes, root) ? null : 'root'
}

/**
 * Decodes the whole of a §6-grammar base64 string. The grammar is checked first, so this
 * only has to be correct on valid input and total on anything else.
 */
function decodeBase64(data: string): Uint8Array {
  let padding = 0
  if (data.endsWith('==')) padding = 2
  else if (data.endsWith('=')) padding = 1
  const groups = Math.floor(data.length / 4)
  const bytes = new Uint8Array(Math.max(0, groups * 3 - padding))
  let out = 0
  for (let i = 0; i < groups; i++) {
    const at = i * 4
    const triple =
      (valueOf(data, at) << 18) |
      (valueOf(data, at + 1) << 12) |
      (valueOf(data, at + 2) << 6) |
      valueOf(data, at + 3)
    if (out < bytes.length) bytes[out++] = (triple >>> 16) & 0xff
    if (out < bytes.length) bytes[out++] = (triple >>> 8) & 0xff
    if (out < bytes.length) bytes[out++] = triple & 0xff
  }
  return bytes
}

function valueOf(data: string, index: number): number {
  const code = data.charCodeAt(index)
  const value = code < 128 ? BASE64_VALUE[code] : -1
  return value === undefined || value < 0 ? 0 : value
}

function at(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1
}

function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf
}

/**
 * Strict UTF-8 (RFC 3629) over every byte, plus no NUL. Rejects stray continuation bytes,
 * overlong forms (C0, C1, E0 below A0, F0 below 90), surrogates (ED above 9F), code points
 * above U+10FFFF (F4 above 8F, F5 to FF), and a truncated sequence. FE and FF never occur in
 * UTF-8, so a UTF-16 byte order mark fails here too.
 */
function isStrictUtf8(bytes: Uint8Array): boolean {
  const length = bytes.length
  let i = 0
  while (i < length) {
    const lead = at(bytes, i)
    if (lead === 0x00) return false
    if (lead < 0x80) {
      i += 1
      continue
    }
    let trailing: number
    let low = 0x80
    let high = 0xbf
    if (lead >= 0xc2 && lead <= 0xdf) {
      trailing = 1
    } else if (lead >= 0xe0 && lead <= 0xef) {
      trailing = 2
      if (lead === 0xe0) low = 0xa0
      if (lead === 0xed) high = 0x9f
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      trailing = 3
      if (lead === 0xf0) low = 0x90
      if (lead === 0xf4) high = 0x8f
    } else {
      return false
    }
    // A byte past the end reads as -1, outside every range: a truncated sequence fails.
    const second = at(bytes, i + 1)
    if (second < low || second > high) return false
    for (let k = 2; k <= trailing; k++) {
      if (!isContinuation(at(bytes, i + k))) return false
    }
    i += trailing + 1
  }
  return true
}

/** XML `S`: space, tab, carriage return, line feed. Never JavaScript's wider `\s`. */
function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a
}

function skipSpace(bytes: Uint8Array, from: number): number {
  let i = from
  while (isSpace(at(bytes, i))) i += 1
  return i
}

function startsWith(bytes: Uint8Array, from: number, text: string): boolean {
  for (let k = 0; k < text.length; k++) {
    if (at(bytes, from + k) !== text.charCodeAt(k)) return false
  }
  return true
}

/**
 * Walks the prolog and answers where the first token after it starts, or `null` for a
 * malformed XML declaration or comment. The prolog is an optional UTF-8 byte order mark,
 * an optional XML declaration at the very start, then any mix of XML whitespace and
 * terminated comments. Whatever follows is the root's to answer for.
 */
function endOfProlog(bytes: Uint8Array): number | null {
  let i = 0
  if (at(bytes, 0) === 0xef && at(bytes, 1) === 0xbb && at(bytes, 2) === 0xbf) i = 3
  // `<?xml` followed by a name character is another processing instruction, such as
  // `<?xml-stylesheet`; it is left for the root check to refuse.
  if (startsWith(bytes, i, '<?xml') && isSpace(at(bytes, i + 5))) {
    const end = endOfDeclaration(bytes, i + 5)
    if (end === null) return null
    i = end
  }
  for (;;) {
    i = skipSpace(bytes, i)
    if (!startsWith(bytes, i, '<!--')) return i
    const end = endOfComment(bytes, i + 4)
    if (end === null) return null
    i = end
  }
}

/**
 * The XML declaration after `<?xml`: S `version` Eq a quoted `1.` and one or more digits,
 * then optionally S `encoding` Eq a quoted `UTF-8` in any ASCII case, then optionally S
 * `standalone` Eq a quoted `yes` or `no`, then S? `?>`. Answers the index after `?>`. The
 * caller has already seen the S after `<?xml`, at `from`.
 */
function endOfDeclaration(bytes: Uint8Array, from: number): number | null {
  const name = skipSpace(bytes, from)
  const version = endOfAttribute(bytes, name, 'version', isVersion)
  if (version === null) return null
  let i = version
  let next = skipSpace(bytes, i)
  if (next > i && startsWith(bytes, next, 'encoding')) {
    const encoding = endOfAttribute(bytes, next, 'encoding', isUtf8Name)
    if (encoding === null) return null
    i = encoding
    next = skipSpace(bytes, i)
  }
  if (next > i && startsWith(bytes, next, 'standalone')) {
    const standalone = endOfAttribute(bytes, next, 'standalone', isYesOrNo)
    if (standalone === null) return null
    next = skipSpace(bytes, standalone)
  }
  if (at(bytes, next) !== QUESTION || at(bytes, next + 1) !== GREATER_THAN) return null
  return next + 2
}

/** One pseudo-attribute of the declaration: `name` Eq a quoted value `accepts` takes. */
function endOfAttribute(
  bytes: Uint8Array,
  from: number,
  name: string,
  accepts: (bytes: Uint8Array, start: number, end: number) => boolean,
): number | null {
  if (!startsWith(bytes, from, name)) return null
  const eq = endOfEq(bytes, from + name.length)
  if (eq === null) return null
  return endOfQuoted(bytes, eq, accepts)
}

/** XML `Eq`: S? `=` S?. Answers the index after it, or `null`. */
function endOfEq(bytes: Uint8Array, from: number): number | null {
  const i = skipSpace(bytes, from)
  if (at(bytes, i) !== EQUALS) return null
  return skipSpace(bytes, i + 1)
}

/**
 * A value in matching single or double quotes whose content `accepts`. Answers the index
 * after the closing quote, or `null`.
 */
function endOfQuoted(
  bytes: Uint8Array,
  from: number,
  accepts: (bytes: Uint8Array, start: number, end: number) => boolean,
): number | null {
  const quote = at(bytes, from)
  if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) return null
  let end = from + 1
  while (end < bytes.length && at(bytes, end) !== quote) end += 1
  if (end >= bytes.length) return null
  return accepts(bytes, from + 1, end) ? end + 1 : null
}

/** `1.` followed by one or more ASCII digits. */
function isVersion(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 3 || !startsWith(bytes, start, '1.')) return false
  for (let i = start + 2; i < end; i++) {
    const byte = at(bytes, i)
    if (byte < 0x30 || byte > 0x39) return false
  }
  return true
}

/** `UTF-8`, ASCII letters in any case. */
function isUtf8Name(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start !== 5) return false
  const lower = (index: number): number => {
    const byte = at(bytes, index)
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
  }
  return (
    lower(start) === 0x75 && // u
    lower(start + 1) === 0x74 && // t
    lower(start + 2) === 0x66 && // f
    at(bytes, start + 3) === HYPHEN &&
    at(bytes, start + 4) === 0x38 // 8
  )
}

/** Exactly `yes` or `no`, as XML spells them. */
function isYesOrNo(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start === 3) return startsWith(bytes, start, 'yes')
  if (end - start === 2) return startsWith(bytes, start, 'no')
  return false
}

/**
 * A comment's body after `<!--`: the first `--` must be the start of `-->`, so a `--`
 * inside the body is refused, as XML refuses it. Answers the index after `-->`, or `null`
 * for an unterminated or ill-formed comment.
 */
function endOfComment(bytes: Uint8Array, from: number): number | null {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (at(bytes, i) === HYPHEN && at(bytes, i + 1) === HYPHEN) {
      return at(bytes, i + 2) === GREATER_THAN ? i + 3 : null
    }
  }
  return null
}

/**
 * The root's start: exactly the bytes `<svg`, then XML whitespace, `>`, or `/>`. So `<svgx`,
 * `<SVG` and a prefixed `<svg:svg` are refused. The scan stops here.
 */
function isSvgRoot(bytes: Uint8Array, from: number): boolean {
  if (at(bytes, from) !== LESS_THAN || !startsWith(bytes, from + 1, 'svg')) return false
  const next = at(bytes, from + 4)
  if (isSpace(next) || next === GREATER_THAN) return true
  return next === SLASH && at(bytes, from + 5) === GREATER_THAN
}
