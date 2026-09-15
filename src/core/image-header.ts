/**
 * Reads the pixel dimensions a PNG, WebP or JPEG header states (spec §6, image header
 * reader).
 *
 * Pure and dependency-free: the base64 prefix is decoded by hand because the core imports no
 * Node built-in. Only the first {@link PREFIX_CHARACTERS} characters are ever decoded, so a
 * 4K image costs the same as a thumbnail. Every rule answers `null` for "unreadable"; a
 * dimension is never guessed.
 *
 * @module
 */

import type { GeneratedImageMediaType } from '../types'

/** What the header stated; both fields are positive safe integers. */
export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

/** The base64 prefix decoded: a multiple of four, decoding to {@link PREFIX_BYTES} bytes. */
export const PREFIX_CHARACTERS = 174_764

/**
 * Enough for one maximum-length JPEG segment (65 535 bytes plus its marker) and a frame
 * header behind it. A JPEG whose frame header sits deeper, behind a large multi-segment
 * ICC profile for instance, is unreadable by the spec's own rule; generated images do not
 * carry those.
 */
export const PREFIX_BYTES = 131_073

/** The JPEG marker walk gives up after this many segments (spec §6). */
const MAX_JPEG_SEGMENTS = 64

const PNG_MAX_DIMENSION = 0x7fff_ffff

const BASE64_VALUE = new Int8Array(128).fill(-1)
for (let i = 0; i < 64; i++) {
  BASE64_VALUE[
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)
  ] = i
}

/**
 * Decodes the first {@link PREFIX_CHARACTERS} characters of §6-grammar base64.
 *
 * The grammar (alphabet, padding placement, length a multiple of four) is the caller's
 * check; this decoder only has to be correct on valid input and total on anything else.
 */
export function decodeBase64Prefix(data: string): Uint8Array {
  const length = Math.min(data.length, PREFIX_CHARACTERS)
  const groups = Math.floor(length / 4)
  let padding = 0
  if (length === data.length) {
    if (data.endsWith('==')) padding = 2
    else if (data.endsWith('=')) padding = 1
  }
  const bytes = new Uint8Array(Math.max(0, groups * 3 - padding))
  let out = 0
  for (let i = 0; i < groups; i++) {
    const at = i * 4
    const a = valueOf(data, at)
    const b = valueOf(data, at + 1)
    const c = valueOf(data, at + 2)
    const d = valueOf(data, at + 3)
    const triple = (a << 18) | (b << 12) | (c << 6) | d
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

/** The byte length of the whole decoded payload, computed without decoding it. */
function decodedLength(data: string): number {
  let padding = 0
  if (data.endsWith('==')) padding = 2
  else if (data.endsWith('=')) padding = 1
  return (data.length / 4) * 3 - padding
}

/**
 * Reads the dimensions the container header states, or `null` when the header is
 * unreadable or does not match `mediaType`.
 *
 * @param mediaType The type the adapter declared; the signature must agree with it.
 * @param data The whole image as §6-grammar base64 (already validated by the caller).
 */
export function readImageDimensions(
  mediaType: GeneratedImageMediaType,
  data: string,
): ImageDimensions | null {
  const bytes = decodeBase64Prefix(data)
  switch (mediaType) {
    case 'image/png':
      return readPng(bytes)
    case 'image/webp':
      return readWebp(bytes, decodedLength(data))
    case 'image/jpeg':
      return readJpeg(bytes)
  }
}

function u8(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0
}

function u16be(bytes: Uint8Array, at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1)
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((u8(bytes, at) << 24) | (u8(bytes, at + 1) << 16) | u16be(bytes, at + 2)) >>> 0
}

function u16le(bytes: Uint8Array, at: number): number {
  return u8(bytes, at) | (u8(bytes, at + 1) << 8)
}

function u24le(bytes: Uint8Array, at: number): number {
  return u16le(bytes, at) | (u8(bytes, at + 2) << 16)
}

function u32le(bytes: Uint8Array, at: number): number {
  return (u16le(bytes, at) | (u16le(bytes, at + 2) << 16)) >>> 0
}

function ascii(bytes: Uint8Array, at: number, expected: string): boolean {
  for (let i = 0; i < expected.length; i++) {
    if (u8(bytes, at + i) !== expected.charCodeAt(i)) return false
  }
  return true
}

function dimensions(width: number, height: number): ImageDimensions | null {
  if (width < 1 || height < 1) return null
  return { width, height }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** PNG: signature, then IHDR as the first chunk with length 13; two big-endian 32-bit fields. */
function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (u8(bytes, i) !== PNG_SIGNATURE[i]) return null
  }
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) return null
  return dimensions(width, height)
}

/**
 * WebP: RIFF header, then the first chunk, which must be one of the three bitstream chunks
 * and whose padded extent must fit both the RIFF size and the file.
 */
function readWebp(bytes: Uint8Array, fileLength: number): ImageDimensions | null {
  if (bytes.length < 20) return null
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null
  const riffSize = u32le(bytes, 4)
  const chunkSize = u32le(bytes, 16)
  const paddedExtent = 8 + chunkSize + (chunkSize & 1)
  // The RIFF size counts everything after itself: 'WEBP' plus the chunks. The file must
  // hold the whole first chunk, whose payload is the bitstream and may be far longer than
  // the decoded prefix; only the header bytes below have to be in the prefix.
  if (4 + paddedExtent > riffSize || 12 + paddedExtent > fileLength) return null
  const payload = 20
  if (ascii(bytes, 12, 'VP8 ')) {
    if (chunkSize < 10 || bytes.length < payload + 10) return null
    if (u8(bytes, payload + 3) !== 0x9d || u8(bytes, payload + 4) !== 0x01) return null
    if (u8(bytes, payload + 5) !== 0x2a) return null
    return dimensions(u16le(bytes, payload + 6) & 0x3fff, u16le(bytes, payload + 8) & 0x3fff)
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (chunkSize < 5 || bytes.length < payload + 5) return null
    if (u8(bytes, payload) !== 0x2f) return null
    const bits = u32le(bytes, payload + 1)
    if (bits >>> 29 !== 0) return null
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (ascii(bytes, 12, 'VP8X')) {
    if (chunkSize !== 10 || bytes.length < payload + 10) return null
    return dimensions(u24le(bytes, payload + 4) + 1, u24le(bytes, payload + 7) + 1)
  }
  return null
}

/** Whether a JPEG marker is a start-of-frame carrying the dimensions (C0 to CF, less C4, C8, CC). */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  )
}

/** JPEG: SOI, then a bounded marker walk to the first start-of-frame segment. */
function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 2 || u8(bytes, 0) !== 0xff || u8(bytes, 1) !== 0xd8) return null
  let at = 2
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS; segments++) {
    if (at >= bytes.length || u8(bytes, at) !== 0xff) return null
    // Fill bytes: any run of FF before the marker byte is padding.
    while (at < bytes.length && u8(bytes, at) === 0xff) at++
    if (at >= bytes.length) return null
    const marker = u8(bytes, at)
    at++
    // RSTn, SOI and TEM are standalone; EOI and SOS mean no frame header precedes the scan.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (at + 2 > bytes.length) return null
    const length = u16be(bytes, at)
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      // The frame segment is bounded like any other: its declared length must fit too.
      if (length < 7 || at + length > bytes.length) return null
      return dimensions(u16be(bytes, at + 5), u16be(bytes, at + 3))
    }
    at += length
    if (at > bytes.length) return null
  }
  return null
}
