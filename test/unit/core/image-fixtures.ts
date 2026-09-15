/**
 * Byte-level builders for the three raster containers the image header reader accepts, so
 * every test that needs a "real" image can make one of any size in one call, and every
 * hostile variant is a documented deviation from a valid file.
 */

import type { GeneratedImageMediaType, ProviderImage } from '../../../src/types'

export function base64(bytes: readonly number[] | Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff]
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function le24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
}

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A PNG header: signature, then IHDR (length 13) with the given size; no further chunks. */
export function png(
  width: number,
  height: number,
  options: { signature?: number[]; chunk?: string; length?: number; trailing?: number[] } = {},
): number[] {
  return [
    ...(options.signature ?? PNG_SIGNATURE),
    ...be32(options.length ?? 13),
    ...ascii(options.chunk ?? 'IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0, // bit depth, colour type, compression, filter, interlace
    ...be32(0), // CRC, not checked
    ...(options.trailing ?? []),
  ]
}

/** A WebP file with one chunk, sized so the RIFF size and the chunk agree unless overridden. */
export function webp(
  fourcc: string,
  payload: number[],
  options: { riffSize?: number; chunkSize?: number; magic?: string } = {},
): number[] {
  const chunkSize = options.chunkSize ?? payload.length
  const padded = payload.length + (payload.length & 1)
  const riffSize = options.riffSize ?? 4 + 8 + padded
  return [
    ...ascii('RIFF'),
    ...le32(riffSize),
    ...ascii(options.magic ?? 'WEBP'),
    ...ascii(fourcc),
    ...le32(chunkSize),
    ...payload,
    ...(payload.length & 1 ? [0] : []),
  ]
}

/** A lossy WebP frame header: 3 tag bytes, the sync code, then two 14-bit fields. */
export function vp8Payload(width: number, height: number, sync = [0x9d, 0x01, 0x2a]): number[] {
  return [0x10, 0x02, 0x00, ...sync, ...le16(width & 0x3fff), ...le16(height & 0x3fff), 0, 0]
}

/** A lossless WebP header: signature 2F, then width-1 and height-1 as 14-bit fields, version 0. */
export function vp8lPayload(width: number, height: number, version = 0): number[] {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | (version << 29)
  return [0x2f, ...le32(bits >>> 0), 0, 0]
}

/** An extended WebP header: flags, reserved, then canvas width-1 and height-1 as 24-bit fields. */
export function vp8xPayload(width: number, height: number): number[] {
  return [0x00, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]
}

export function webpVP8(width: number, height: number): number[] {
  return webp('VP8 ', vp8Payload(width, height))
}

export function webpVP8L(width: number, height: number): number[] {
  return webp('VP8L', vp8lPayload(width, height))
}

export function webpVP8X(width: number, height: number): number[] {
  return webp('VP8X', vp8xPayload(width, height))
}

/** One JPEG segment with a marker and a length-prefixed body (length counts itself). */
export function segment(marker: number, body: number[], length = body.length + 2): number[] {
  return [0xff, marker, ...be16(length), ...body]
}

/** A baseline start-of-frame body: precision 8, height, width, one component. */
export function sofBody(width: number, height: number): number[] {
  return [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]
}

/** SOI, the given segments, then SOF0 with the size, then SOS (never reached by the reader). */
export function jpeg(width: number, height: number, before: number[][] = []): number[] {
  return [
    0xff,
    0xd8,
    ...before.flat(),
    ...segment(0xc0, sofBody(width, height)),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
  ]
}

/** An APP1 segment of the given body length, filled with zeros. */
export function app1(bodyLength: number): number[] {
  return segment(0xe1, new Array<number>(bodyLength).fill(0))
}

/** A `ProviderImage` for a real header of the given container, dimensions left to the core. */
export function providerImage(
  mediaType: GeneratedImageMediaType,
  width = 1,
  height = 1,
): ProviderImage {
  const bytes =
    mediaType === 'image/png'
      ? png(width, height)
      : mediaType === 'image/webp'
        ? webpVP8L(width, height)
        : jpeg(width, height)
  return { mediaType, data: base64(bytes) }
}
