/**
 * The image header reader (spec §6): each container and variant on minimal valid files,
 * the two axes told apart, every documented way a header is unreadable, the bounded decode,
 * and the containers' own limits.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeBase64Prefix,
  PREFIX_BYTES,
  PREFIX_CHARACTERS,
  readImageDimensions,
} from '../../../src/core/image-header'
import {
  app1,
  base64,
  jpeg,
  png,
  PNG_SIGNATURE,
  segment,
  sofBody,
  vp8lPayload,
  vp8Payload,
  vp8xPayload,
  webp,
  webpVP8,
  webpVP8L,
  webpVP8X,
} from './image-fixtures'

describe('the base64 prefix decoder', () => {
  it('decodes a whole short payload, padding included', () => {
    expect([...decodeBase64Prefix(base64([1, 2, 3, 4]))]).toEqual([1, 2, 3, 4])
    expect([...decodeBase64Prefix(base64([1, 2, 3, 4, 5]))]).toEqual([1, 2, 3, 4, 5])
    expect([...decodeBase64Prefix(base64([1, 2, 3]))]).toEqual([1, 2, 3])
    expect([...decodeBase64Prefix(base64([255]))]).toEqual([255])
  })

  it('decodes exactly the prefix of a longer payload and nothing past it', () => {
    const bytes = new Uint8Array(PREFIX_BYTES + 1000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    const decoded = decodeBase64Prefix(base64(bytes))
    expect(decoded.length).toBe(PREFIX_BYTES)
    expect(PREFIX_CHARACTERS % 4).toBe(0)
    expect((PREFIX_CHARACTERS / 4) * 3).toBe(PREFIX_BYTES)
    expect(decoded[0]).toBe(0)
    expect(decoded[PREFIX_BYTES - 1]).toBe((PREFIX_BYTES - 1) & 0xff)
  })
})

describe('PNG', () => {
  it('reads a 1×1 and tells the axes apart on 2×3', () => {
    expect(readImageDimensions('image/png', base64(png(1, 1)))).toEqual({ width: 1, height: 1 })
    expect(readImageDimensions('image/png', base64(png(2, 3)))).toEqual({ width: 2, height: 3 })
  })

  it('accepts the specification ceiling and rejects one past it', () => {
    const max = 0x7fff_ffff
    expect(readImageDimensions('image/png', base64(png(max, 1)))).toEqual({
      width: max,
      height: 1,
    })
    expect(readImageDimensions('image/png', base64(png(1, max + 1)))).toBeNull()
  })

  const unreadable: [string, number[]][] = [
    ['a truncated header', png(2, 3).slice(0, 20)],
    ['a failed signature', png(2, 3, { signature: [...PNG_SIGNATURE.slice(0, 7), 0x0b] })],
    ['a first chunk that is not IHDR', png(2, 3, { chunk: 'IDAT' })],
    ['an IHDR whose declared length is not 13', png(2, 3, { length: 14 })],
    ['a zero width', png(0, 3)],
    ['a zero height', png(2, 0)],
    ['an empty payload', []],
  ]
  for (const [name, bytes] of unreadable) {
    it(`is unreadable on ${name}`, () => {
      expect(readImageDimensions('image/png', base64(bytes))).toBeNull()
    })
  }

  it('is unreadable when the mime does not match the signature', () => {
    expect(readImageDimensions('image/jpeg', base64(png(2, 3)))).toBeNull()
    expect(readImageDimensions('image/webp', base64(png(2, 3)))).toBeNull()
  })
})

describe('WebP', () => {
  it('reads each variant on 1×1 and 2×3', () => {
    for (const build of [webpVP8, webpVP8L, webpVP8X]) {
      expect(readImageDimensions('image/webp', base64(build(1, 1)))).toEqual({
        width: 1,
        height: 1,
      })
      expect(readImageDimensions('image/webp', base64(build(2, 3)))).toEqual({
        width: 2,
        height: 3,
      })
    }
  })

  it('reads a bitstream chunk far longer than the decoded prefix', () => {
    // A real lossy image: the VP8 chunk is the whole picture, only its header is decoded.
    const payload = [...vp8Payload(2000, 1500), ...new Array<number>(PREFIX_BYTES).fill(7)]
    expect(readImageDimensions('image/webp', base64(webp('VP8 ', payload)))).toEqual({
      width: 2000,
      height: 1500,
    })
  })

  it('accepts the VP8X 24-bit canvas ceiling and the 14-bit lossless ceiling', () => {
    expect(readImageDimensions('image/webp', base64(webpVP8X(1 << 24, 1 << 24)))).toEqual({
      width: 1 << 24,
      height: 1 << 24,
    })
    expect(readImageDimensions('image/webp', base64(webpVP8L(16384, 16384)))).toEqual({
      width: 16384,
      height: 16384,
    })
  })

  const unreadable: [string, number[]][] = [
    ['a truncated RIFF header', webpVP8L(2, 3).slice(0, 19)],
    ['a RIFF magic that is not WEBP', webp('VP8L', vp8lPayload(2, 3), { magic: 'WAVE' })],
    ['a first chunk that is not a bitstream chunk', webp('ICCP', vp8lPayload(2, 3))],
    ['an ALPH chunk first', webp('ALPH', [0, 0, 0, 0, 0, 0])],
    ['a RIFF size too small for the chunk', webp('VP8L', vp8lPayload(2, 3), { riffSize: 10 })],
    [
      'a chunk size that runs past the file',
      webp('VP8L', vp8lPayload(2, 3), { chunkSize: 1000, riffSize: 1012 }),
    ],
    ['a VP8 payload shorter than 10', webp('VP8 ', vp8Payload(2, 3).slice(0, 9))],
    ['a VP8 frame without the sync code', webp('VP8 ', vp8Payload(2, 3, [0x9d, 0x01, 0x2b]))],
    [
      'a VP8 frame with the first sync byte wrong',
      webp('VP8 ', vp8Payload(2, 3, [0x9c, 0x01, 0x2a])),
    ],
    [
      'a VP8 frame with the second sync byte wrong',
      webp('VP8 ', vp8Payload(2, 3, [0x9d, 0x00, 0x2a])),
    ],
    ['a VP8 zero width', webpVP8(0, 3)],
    ['a VP8L payload shorter than 5', webp('VP8L', vp8lPayload(2, 3).slice(0, 4))],
    [
      'a VP8L signature byte that is not 2F',
      webp('VP8L', [0x2e, ...vp8lPayload(2, 3).slice(1)]),
    ],
    ['a VP8L version that is not zero', webp('VP8L', vp8lPayload(2, 3, 1))],
    ['a VP8X chunk whose length is not 10', webp('VP8X', [...vp8xPayload(2, 3), 0, 0])],
    [
      'a VP8X chunk declared 10 but shorter',
      webp('VP8X', vp8xPayload(2, 3).slice(0, 8), { chunkSize: 10 }),
    ],
    ['an empty payload', []],
  ]
  for (const [name, bytes] of unreadable) {
    it(`is unreadable on ${name}`, () => {
      expect(readImageDimensions('image/webp', base64(bytes))).toBeNull()
    })
  }

  it('is unreadable when the mime does not match the signature', () => {
    expect(readImageDimensions('image/png', base64(webpVP8L(2, 3)))).toBeNull()
    expect(readImageDimensions('image/jpeg', base64(webpVP8L(2, 3)))).toBeNull()
  })
})

describe('JPEG', () => {
  it('reads a 1×1 and tells the axes apart on 2×3', () => {
    expect(readImageDimensions('image/jpeg', base64(jpeg(1, 1)))).toEqual({
      width: 1,
      height: 1,
    })
    expect(readImageDimensions('image/jpeg', base64(jpeg(2, 3)))).toEqual({
      width: 2,
      height: 3,
    })
  })

  it('walks past APP and comment segments, fill bytes and standalone markers', () => {
    const before = [
      segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      [0xff, 0xff, 0xff, 0xd0], // fill bytes then RST0, standalone
      [0xff, 0x01], // TEM, standalone
      [0xff, 0xd8], // a second SOI is standalone too
      segment(0xfe, [0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74]), // 'comment'
      segment(0xc4, [0, 1, 2]), // DHT is not a frame header
      segment(0xdb, new Array<number>(65).fill(1)),
    ]
    expect(readImageDimensions('image/jpeg', base64(jpeg(640, 480, before)))).toEqual({
      width: 640,
      height: 480,
    })
  })

  it('reads every start-of-frame marker but DHT, JPG and DAC', () => {
    for (let marker = 0xc0; marker <= 0xcf; marker++) {
      const bytes = [0xff, 0xd8, ...segment(marker, sofBody(4, 5))]
      const expected = marker === 0xc4 || marker === 0xc8 || marker === 0xcc
      const read = readImageDimensions('image/jpeg', base64(bytes))
      // The excluded three are skipped by length; the walk then runs off the end.
      expect(read).toEqual(expected ? null : { width: 4, height: 5 })
    }
  })

  it('reads a frame header behind a maximum-length APP1 segment inside the prefix', () => {
    // 65 533 body bytes + 2 length bytes = 65 535, the u16 ceiling.
    expect(readImageDimensions('image/jpeg', base64(jpeg(7, 9, [app1(65_533)])))).toEqual({
      width: 7,
      height: 9,
    })
  })

  it('reads a frame header behind exactly 64 segments and gives up at the 65th', () => {
    const sixtyThree = new Array<number[]>(63).fill(segment(0xfe, [1]))
    expect(readImageDimensions('image/jpeg', base64(jpeg(2, 3, sixtyThree)))).toEqual({
      width: 2,
      height: 3,
    })
    const sixtyFour = new Array<number[]>(64).fill(segment(0xfe, [1]))
    expect(readImageDimensions('image/jpeg', base64(jpeg(2, 3, sixtyFour)))).toBeNull()
  })

  it('counts standalone markers as segments too', () => {
    const sixtyFour = new Array<number[]>(64).fill([0xff, 0xd0])
    expect(readImageDimensions('image/jpeg', base64(jpeg(2, 3, sixtyFour)))).toBeNull()
  })

  const unreadable: [string, number[]][] = [
    ['a truncated header', jpeg(2, 3).slice(0, 8)],
    ['a missing SOI', jpeg(2, 3).slice(1)],
    ['a segment with length 0', [0xff, 0xd8, ...segment(0xfe, [], 0), ...jpeg(2, 3).slice(2)]],
    ['a segment with length 1', [0xff, 0xd8, ...segment(0xfe, [], 1), ...jpeg(2, 3).slice(2)]],
    ['a segment whose length runs past the prefix', jpeg(2, 3, [app1(65_533), app1(65_533)])],
    ['a segment whose length runs past the file', [0xff, 0xd8, ...segment(0xfe, [1], 500)]],
    ['a start of frame shorter than 7', [0xff, 0xd8, ...segment(0xc0, [8, 0, 3, 0], 6)]],
    [
      'a start of frame declared longer than the file',
      [0xff, 0xd8, ...segment(0xc0, sofBody(2, 3), 65_535)],
    ],
    [
      'a start of frame declared past the prefix',
      [0xff, 0xd8, ...app1(65_533), ...segment(0xc0, sofBody(2, 3), 65_535)],
    ],
    [
      'a scan before any frame header',
      [0xff, 0xd8, ...segment(0xda, [1]), ...jpeg(2, 3).slice(2)],
    ],
    ['an end of image before any frame header', [0xff, 0xd8, 0xff, 0xd9]],
    ['a zero width', jpeg(0, 3)],
    ['a zero height', jpeg(2, 0)],
    ['a byte that is not a marker prefix', [0xff, 0xd8, 0x00, 0xc0]],
    ['a trailing lone FF', [0xff, 0xd8, 0xff]],
    ['a marker with one byte left for its length', [0xff, 0xd8, 0xff, 0xfe, 0x00]],
    ['an empty payload', []],
  ]
  for (const [name, bytes] of unreadable) {
    it(`is unreadable on ${name}`, () => {
      expect(readImageDimensions('image/jpeg', base64(bytes))).toBeNull()
    })
  }

  it('is unreadable when the mime does not match the signature', () => {
    expect(readImageDimensions('image/png', base64(jpeg(2, 3)))).toBeNull()
    expect(readImageDimensions('image/webp', base64(jpeg(2, 3)))).toBeNull()
  })
})
