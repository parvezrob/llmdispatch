/**
 * The live check's image and SVG probes, run dry: the package's sources, a scripted `fetch`
 * and a fake key, so no provider is called and nothing is spent. What this proves is the
 * structure of the probes (the operation each one builds, what reaches the wire, what each
 * expectation checks, and what is printed when a probe learns something) and the pieces the
 * probes are built from: the independent header reader, the rough SVG reading, and the
 * guard on printing any part of a refused document. Only the live run proves the providers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  OMITTED_RUN,
  SVG_CAPS,
  carriesKeyMaterial,
  decodeBase64,
  describeSvgShape,
  diagnoseSvg,
  previewIfSafe,
  readProbes,
  readRasterHeader,
  runProbes,
  withoutComments,
} from '../../../scripts/runners/image-probes.mjs'
import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
} from '../../../src/core/svg-document'
import * as llmdispatch from '../../../src/index'
import { base64, jpeg, png, webpVP8, webpVP8L, webpVP8X } from '../core/image-fixtures'
import { captureRequests, jsonResponse } from '../providers/helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A key-shaped fake, assembled at run time so the repository never holds one. */
const KEY = ['sk', 'or', 'v1', 'livecheckdryrunfakekey0123456789'].join('-')

/** A PNG header whose IHDR declares the given colour type (6, RGBA, by default). */
function pngOf(width: number, height: number, colourType = 6, trailing: number[] = []): string {
  const bytes = png(width, height, { trailing })
  bytes[25] = colourType
  return base64(bytes)
}

/** A one-byte tRNS chunk, as a palette or RGB PNG carries it. */
const TRNS = [0, 0, 0, 1, 0x74, 0x52, 0x4e, 0x53, 0, 0, 0, 0, 0]

function svg(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function probe(adapter: string, probes: unknown[]) {
  const lines: string[] = []
  const problems = await runProbes({
    llmdispatch,
    z,
    adapter,
    apiKey: KEY,
    probes,
    signal: new AbortController().signal,
    write: (line: string) => lines.push(line),
  })
  return { lines, problems }
}

describe('the probes reading an image header from outside the core', () => {
  it('reads a PNG and its declared alpha', () => {
    const header = (data: string) => readRasterHeader(Buffer.from(data, 'base64'))
    expect(header(pngOf(3, 2))).toEqual({
      mediaType: 'image/png',
      width: 3,
      height: 2,
      alpha: true,
    })
    expect(header(pngOf(3, 2, 4))?.alpha).toBe(true)
    expect(header(pngOf(3, 2, 2))?.alpha).toBe(false)
    expect(header(pngOf(3, 2, 2, TRNS))?.alpha).toBe(true)
  })

  it('reads JPEG and the three WebP headers', () => {
    const header = (bytes: number[]) => readRasterHeader(Buffer.from(bytes))
    expect(header(jpeg(5, 7))).toEqual({
      mediaType: 'image/jpeg',
      width: 5,
      height: 7,
      alpha: false,
    })
    expect(header(webpVP8(9, 4))).toMatchObject({ width: 9, height: 4, alpha: false })
    expect(header(webpVP8L(9, 4))).toMatchObject({ width: 9, height: 4 })
    expect(header(webpVP8X(9, 4))).toMatchObject({
      mediaType: 'image/webp',
      width: 9,
      height: 4,
    })
  })

  it('steps over a repeated start-of-image marker, and refuses a frame header cut short', () => {
    const header = (bytes: number[]) => readRasterHeader(Buffer.from(bytes))
    const [soi0 = 0, soi1 = 0, ...rest] = jpeg(5, 7)
    expect(header([soi0, soi1, 0xff, 0xd8, ...rest])).toMatchObject({ width: 5, height: 7 })
    // SOF0 declaring a 17-byte segment where only the frame header's 11 bytes follow.
    expect(header([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 7, 0, 5, 1, 1, 0x11, 0])).toBeNull()
  })

  it('reads nothing from bytes that are not one of the three', () => {
    expect(readRasterHeader(Buffer.from('<svg/>'))).toBeNull()
    expect(readRasterHeader(Buffer.from([]))).toBeNull()
  })

  it('decodes canonical base64 only', () => {
    expect(decodeBase64(pngOf(1, 1))).not.toBeNull()
    expect(decodeBase64('abc')).toBeNull()
    expect(decodeBase64('YWJj\n')).toBeNull()
    expect(decodeBase64('')).toBeNull()
  })
})

describe('the probes reading an SVG document roughly', () => {
  const read = (text: string) => diagnoseSvg(Buffer.from(text, 'utf8'))

  it('sees nothing wrong with an SVG-rooted document', () => {
    expect(read('<svg/>')).toBeNull()
    expect(read('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="x">')).toBeNull()
    expect(read('<!-- mentions <!DOCTYPE svg> --><svg>')).toBeNull()
    expect(read('<!-- an <svg> inside a comment --><svg/>')).toBeNull()
  })

  it('names the reason it would refuse one', () => {
    expect(read('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>')).toMatch(/DOCTYPE/)
    expect(read('<?xml-stylesheet href="a.css"?><svg/>')).toMatch(/processing instruction/)
    expect(read('<?xml version="1.0" encoding="ISO-8859-1"?><svg/>')).toMatch(/encoding/)
    expect(read('<svg>\u0000</svg>')).toMatch(/NUL/)
    expect(read('<html/>')).toMatch(/no <svg root/)
    expect(read('<!-- <svg/> --><html/>')).toMatch(/no <svg root/)
    expect(read('<!-- never closed <svg/>')).toMatch(/never closes/)
  })

  it('reads the prolog only, as the core does, so a comment left open after the root passes', () => {
    expect(read('<svg/><!-- unterminated')).toBeNull()
    expect(read('<svg><g/></svg>\n<!-- trailing, never closed')).toBeNull()
    expect(diagnoseSvg(Buffer.from([0x3c, 0xff, 0x3e]))).toMatch(/UTF-8/)
  })
})

describe('the probes removing comments', () => {
  it('removes what the lazy comment pattern removes, and nothing else', () => {
    for (const text of [
      '',
      '<svg/>',
      '<!-- a --><svg/>',
      '<!-- a --><svg><!-- b --></svg>',
      '<!--><svg/>-->',
      '<!---->x<!--',
      '<!-- <!-- nested --> -->',
      '<svg/><!-- never closed',
      '<!-- one --> <!-- two',
      '--><!--<!---->',
    ]) {
      expect(withoutComments(text)).toBe(text.replace(/<!--[\s\S]*?-->/g, ''))
    }
  })

  // The lazy pattern rescans to the end for every opening it cannot close: on this document
  // it ran for seconds, and on a few megabytes for minutes. A scan finishes at once.
  it('reads a document that opens many comments and closes none in one pass', () => {
    const document = Buffer.from(`<svg>${'<!--'.repeat(200_000)}</svg>`, 'utf8')
    const started = performance.now()
    expect(diagnoseSvg(document)).toBeNull()
    expect(describeSvgShape(document)).toMatchObject({ elements: 1, subpaths: 0 })
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('the probes describing the shape of an SVG document', () => {
  const shape = (text: string) => describeSvgShape(Buffer.from(text, 'utf8'))

  /** Two paths, one with three subpaths in both cases and one in single quotes, and a <use>. */
  const ICON = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- <style> and <text> in a comment are not counted -->',
    '<svg xmlns="x" viewBox="0 0 24 24">',
    '  <defs><path id="leaf" d="M2 2h4v4zm6 0h4v4zM14 2h4v4z"/></defs>',
    "  <path d='M0 0L24 24'/>",
    '  <use href="#leaf"/>',
    '</svg>',
  ].join('\n')

  it('counts elements, subpaths and path bytes, and sees <use> only where it is used', () => {
    expect(shape(ICON)).toEqual({
      elements: 5,
      subpaths: 4,
      pathBytes: 'M2 2h4v4zm6 0h4v4zM14 2h4v4z'.length + 'M0 0L24 24'.length,
      style: false,
      text: false,
      use: true,
    })
  })

  it('sees <style> and <text>, and an empty document as nothing at all', () => {
    expect(shape('<svg><style>path{fill:red}</style><text>hi</text></svg>')).toMatchObject({
      elements: 3,
      subpaths: 0,
      pathBytes: 0,
      style: true,
      text: true,
      use: false,
    })
    expect(shape('')).toEqual({
      elements: 0,
      subpaths: 0,
      pathBytes: 0,
      style: false,
      text: false,
      use: false,
    })
  })

  it('counts path data in bytes, not characters', () => {
    expect(shape('<svg><path d="M0 0é"/></svg>').pathBytes).toBe(6)
  })
})

describe('the guard on printing part of a document', () => {
  /** The preview as a string, or `null` when it was withheld. */
  const shown = (text: string): string | null => {
    const preview = previewIfSafe(Buffer.from(text, 'utf8'), [KEY])
    return preview === null ? null : (JSON.parse(preview) as string)
  }

  it('prints at most the first 200 bytes as a JSON string', () => {
    const preview = previewIfSafe(Buffer.from(`<svg>${'a b '.repeat(100)}`), [KEY])
    expect(preview).not.toBeNull()
    expect((JSON.parse(preview ?? '""') as string).length).toBe(200)
  })

  it('keeps a real prolog readable, which is the question the preview answers', () => {
    const prolog =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n' +
      '<svg xmlns="x" viewBox="0 0 64 64"><title>red apple</title>'
    expect(shown(prolog)).toBe(prolog)
  })

  it('omits a long base64 run, including base64 of a bearer header carrying the key', () => {
    const bearer = Buffer.from(`Bearer ${KEY}`, 'utf8').toString('base64')
    const text = shown(`<!DOCTYPE svg><svg><desc>${bearer}</desc>`)
    expect(text).toBe(`<!DOCTYPE svg><svg><desc>${OMITTED_RUN}</desc>`)
  })

  it('omits the key itself, its base64url and its hex, so none of them reaches the output', () => {
    const encoded = Buffer.from(KEY, 'utf8')
    for (const form of [KEY, encoded.toString('base64url'), encoded.toString('hex')]) {
      const text = shown(`<!DOCTYPE svg><svg id="${form}">`)
      expect(text).toBe(`<!DOCTYPE svg><svg id="${OMITTED_RUN}">`)
    }
  })

  it('withholds a key split across lines into pieces too short to be omitted', () => {
    const pieces = (KEY.match(/.{1,12}/g) ?? []).join('\n')
    expect(shown(`<!DOCTYPE svg><svg><desc>${pieces}</desc>`)).toBeNull()
  })

  it('omits a long path, which costs nothing the preview is for', () => {
    const text = shown('<!DOCTYPE svg><svg><path d="M10/20L30/40L50/60L70/80L90/100Z"/>')
    expect(text).toBe(`<!DOCTYPE svg><svg><path d="${OMITTED_RUN}"/>`)
  })

  it('withholds them when they carry a fragment of the key or anything key-shaped', () => {
    expect(previewIfSafe(Buffer.from(`<svg>${KEY.slice(10, 18)}</svg>`), [KEY])).toBeNull()
    const other = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-')
    expect(carriesKeyMaterial(`<svg>${other}</svg>`, [])).toBe(true)
    expect(carriesKeyMaterial('<svg>skeleton-key</svg>', [KEY])).toBe(false)
  })

  it('withholds them when they carry the key in base64 or hex', () => {
    const encoded = Buffer.from(KEY, 'utf8')
    const base64Run = encoded.toString('base64').slice(4, 12)
    const hexRun = encoded.toString('hex').slice(20, 28)
    expect(carriesKeyMaterial(`<svg>${base64Run}</svg>`, [KEY])).toBe(true)
    expect(carriesKeyMaterial(`<svg>${hexRun}</svg>`, [KEY])).toBe(true)
  })
})

describe('the probes restating the core', () => {
  it('holds the SVG caps to the core values', () => {
    expect(SVG_CAPS).toEqual({
      count: MAX_RESPONSE_SVGS,
      perDocument: MAX_SVG_CHARACTERS,
      perResponse: MAX_RESPONSE_SVG_CHARACTERS,
    })
  })
})

describe('the probe table', () => {
  it('accepts the shape the parent writes', () => {
    const problems: string[] = []
    const table = [
      {
        label: 'one',
        model: 'm',
        format: 'image',
        image: { size: '1K' },
        adapterOptions: { quality: 'low' },
        expect: { alpha: true },
      },
      { label: 'two', model: 'm', format: 'svg' },
    ]
    expect(readProbes(JSON.stringify(table), problems)).toEqual(table)
    expect(problems).toEqual([])
  })

  it('names what is wrong with one that is not', () => {
    const problems: string[] = []
    const table = [
      {
        label: '',
        model: 'm',
        format: 'video',
        expect: { sharp: true },
        adapterOptions: { moderation: 'low' },
      },
    ]
    expect(readProbes(JSON.stringify(table), problems)).toBeNull()
    expect(problems).toEqual([
      'probe 1: no label',
      "probe 1: format is neither 'image' nor 'svg'",
      "probe 1: unknown expectation 'sharp'",
      "probe 1: unknown adapter option 'moderation'",
    ])
    expect(readProbes('[]', [])).toBeNull()
    expect(readProbes('{', [])).toBeNull()
  })
})

describe('the OpenAI image probe, dry', () => {
  const TRANSPARENT = {
    label: 'two transparent 1K images',
    model: 'gpt-image-x',
    format: 'image',
    image: { count: 2, aspectRatio: '1:1', size: '1K', background: 'transparent' },
    adapterOptions: { quality: 'low' },
    expect: { mediaType: 'image/png', alpha: true, pixels: '1024x1024', usage: true },
  }

  function answer(colourType: number) {
    return jsonResponse(200, {
      created: 1,
      output_format: 'png',
      size: '1024x1024',
      data: [
        { b64_json: pngOf(1024, 1024, colourType) },
        { b64_json: pngOf(1024, 1024, colourType) },
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 400,
        output_tokens_details: { image_tokens: 390 },
      },
    })
  }

  it('sends the knobs and passes two transparent images of the asked size', async () => {
    const { requests } = captureRequests(() => answer(6))
    const { lines, problems } = await probe('openai-images', [TRANSPARENT])
    expect(problems).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: 'gpt-image-x',
      n: 2,
      size: '1024x1024',
      background: 'transparent',
      quality: 'low',
    })
    expect(lines[0]).toMatch(/usage 9 in, 400 out \(of which 390 image\), no reported cost$/)
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/image 1: image\/png 1024x1024, \d+ bytes, alpha channel$/),
      expect.stringMatching(/image 2: image\/png 1024x1024, \d+ bytes, alpha channel$/),
    ])
  })

  it('fails images that declare no alpha channel', async () => {
    captureRequests(() => answer(2))
    const { problems } = await probe('openai-images', [TRANSPARENT])
    expect(problems).toEqual([
      'gpt-image-x (two transparent 1K images), image 1: no alpha channel, though the request asked for transparency',
      'gpt-image-x (two transparent 1K images), image 2: no alpha channel, though the request asked for transparency',
    ])
  })

  it('fails images of another size than the one asked for', async () => {
    captureRequests(() => answer(6))
    const { problems } = await probe('openai-images', [
      { ...TRANSPARENT, expect: { ...TRANSPARENT.expect, pixels: '2048x2048' } },
    ])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/1024x1024, expected 2048x2048$/)
  })

  it('passes an opaque 2K image when the probe asks for no alpha channel', async () => {
    const opaque = {
      label: 'one 2K image',
      model: 'gpt-image-x',
      format: 'image',
      image: { aspectRatio: '1:1', size: '2K' },
      adapterOptions: { quality: 'low' },
      expect: { mediaType: 'image/png', pixels: '2048x2048', usage: true },
    }
    const { requests } = captureRequests(() =>
      jsonResponse(200, {
        size: '2048x2048',
        data: [{ b64_json: pngOf(2048, 2048, 2) }],
        usage: { input_tokens: 9, output_tokens: 400 },
      }),
    )
    const { lines, problems } = await probe('openai-images', [opaque])
    expect(problems).toEqual([])
    expect(requests[0]?.body).toEqual({
      model: 'gpt-image-x',
      prompt: expect.any(String) as string,
      size: '2048x2048',
      quality: 'low',
    })
    expect(lines[1]).toMatch(/image 1: image\/png 2048x2048, \d+ bytes, no alpha channel$/)
  })

  it('names a rejected setting as invalid_request with its status, not as a refusal', async () => {
    captureRequests(() =>
      jsonResponse(400, {
        error: {
          message: 'Transparent background is not supported for this model.',
          type: 'image_generation_user_error',
          param: 'background',
          code: 'invalid_value',
        },
      }),
    )
    const { problems } = await probe('openai-images', [TRANSPARENT])
    expect(problems).toEqual([
      'gpt-image-x (two transparent 1K images): LLMDispatchError(PROVIDER_FAILED), final attempt invalid_request, HTTP 400',
    ])
  })

  it('names a classified failure by its code and outcome only', async () => {
    captureRequests(() =>
      jsonResponse(401, { error: { message: 'bad key', code: 'invalid_api_key' } }),
    )
    const { problems } = await probe('openai-images', [TRANSPARENT])
    expect(problems).toEqual([
      'gpt-image-x (two transparent 1K images): LLMDispatchError(INVALID_CONFIG), final attempt auth, HTTP 401',
    ])
  })
})

describe('the Gemini candidate-count probe, dry', () => {
  const COUNT = {
    label: 'two 1K images',
    model: 'gemini-image-x',
    format: 'image',
    image: { count: 2, size: '1K' },
    expect: { usage: true, countProbe: true },
  }

  const candidate = () => ({
    content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngOf(1024, 1024, 2) } }] },
    finishReason: 'STOP',
  })

  const body = (candidates: unknown[]) =>
    jsonResponse(200, {
      candidates,
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 1290,
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }],
      },
    })

  it('reports two images as a finding, not a failure', async () => {
    captureRequests(() => body([candidate(), candidate()]))
    const { lines, problems } = await probe('gemini', [COUNT])
    expect(problems).toEqual([])
    expect(lines).toContain(
      'finding: gemini-image-x (two 1K images): asked for 2 image(s) and got them all',
    )
  })

  it('reports fewer images as a finding, not a failure', async () => {
    captureRequests(() => body([candidate()]))
    const { lines, problems } = await probe('gemini', [COUNT])
    expect(problems).toEqual([])
    expect(lines).toContain(
      'finding: gemini-image-x (two 1K images): asked for 2 image(s), got 1',
    )
  })

  it('reports a refused count as a finding and checks one image instead', async () => {
    let calls = 0
    const { requests } = captureRequests(() => {
      calls += 1
      return calls === 1
        ? jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'no' } })
        : body([candidate()])
    })
    const { lines, problems } = await probe('gemini', [COUNT])
    expect(problems).toEqual([])
    expect(lines[0]).toBe(
      'gemini-image-x (two 1K images): count 2 answered ' +
        'LLMDispatchError(PROVIDER_FAILED), final attempt invalid_request, HTTP 400; ' +
        'asking for one image instead',
    )
    // The verdict comes only after the single image has answered.
    expect(lines[lines.length - 1]).toBe(
      'finding: gemini-image-x (two 1K images): the model refused count 2 and answered one ' +
        'image, so it takes no candidate count',
    )
    expect(requests).toHaveLength(2)
    const config = (index: number) =>
      (requests[index]?.body as { generationConfig: Record<string, unknown> }).generationConfig
    expect(config(0)).toMatchObject({ candidateCount: 2, imageConfig: { imageSize: '1K' } })
    expect(config(1)).not.toHaveProperty('candidateCount')
    expect(config(1)).toMatchObject({ imageConfig: { imageSize: '1K' } })
  })
})

describe('the Gemini candidate-count probe, refused twice', () => {
  it('fails, and says the 400 is not about the count', async () => {
    const { requests } = captureRequests(() =>
      jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'no' } }),
    )
    const { lines, problems } = await probe('gemini', [
      {
        label: 'two 1K images',
        model: 'gemini-image-x',
        format: 'image',
        image: { count: 2, size: '1K' },
        expect: { usage: true, countProbe: true },
      },
    ])
    expect(requests).toHaveLength(2)
    expect(problems).toEqual([
      'gemini-image-x (two 1K images, one image instead): LLMDispatchError(PROVIDER_FAILED), ' +
        'final attempt invalid_request, HTTP 400',
    ])
    expect(lines[lines.length - 1]).toBe(
      'finding: gemini-image-x (two 1K images): the single image was refused the same way, so ' +
        'the 400 is not specific to count; whether the model takes a candidate count is unsettled',
    )
    expect(lines.join('\n')).not.toContain('takes no candidate count')
  })
})

describe('the OpenRouter probes, dry', () => {
  const RASTER = {
    label: 'one 1K image',
    model: 'bytedance-seed/seedream-x',
    format: 'image',
    image: { size: '1K' },
    expect: { reportedCost: true },
  }
  const VECTOR = {
    label: 'one SVG document',
    model: 'recraft/recraft-vector-x',
    format: 'svg',
    expect: { reportedCost: true },
  }

  const answer = (data: string, mediaType: string, cost?: number) =>
    jsonResponse(200, {
      data: [{ b64_json: data, media_type: mediaType }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 0,
        ...(cost === undefined ? {} : { cost }),
      },
    })

  it('passes a raster image with a reported cost', async () => {
    const { requests } = captureRequests(() =>
      answer(base64(jpeg(1024, 1024)), 'image/jpeg', 0.04),
    )
    const { lines, problems } = await probe('openrouter-images', [RASTER])
    expect(problems).toEqual([])
    expect(requests[0]?.body).toMatchObject({ resolution: '1K' })
    expect(lines[0]).toMatch(/reported cost \$0\.0400$/)
  })

  it('fails a raster image whose cost was not reported', async () => {
    captureRequests(() => answer(base64(jpeg(1024, 1024)), 'image/jpeg'))
    const { problems } = await probe('openrouter-images', [RASTER])
    expect(problems).toEqual(['bytedance-seed/seedream-x (one 1K image): no cost was reported'])
  })

  it('passes an SVG document the core accepts, and reports its size', async () => {
    const document = '<svg xmlns="x" viewBox="0 0 1 1"/>'
    const { requests } = captureRequests(() => answer(svg(document), 'image/svg+xml', 0.08))
    const { lines, problems } = await probe('openrouter-images', [VECTOR])
    expect(problems).toEqual([])
    expect(requests[0]?.body).toMatchObject({ output_format: 'svg' })
    expect(lines).toEqual([
      expect.stringMatching(/reported cost \$0\.0800$/),
      `  document 1: ${String(document.length)} bytes (${String(svg(document).length)} base64 characters)`,
      'finding: recraft/recraft-vector-x (one SVG document), document 1: 1 elements, ' +
        '0 subpaths, 0 bytes of path data; <style> no, <text> no, <use> no',
    ])
  })

  it('reports the shape of each document it passes as one finding line', async () => {
    const document =
      '<svg xmlns="x" viewBox="0 0 2 2"><style>*{}</style><path d="M0 0h1zM1 1h1z"/></svg>'
    captureRequests(() => answer(svg(document), 'image/svg+xml', 0.08))
    const { lines, problems } = await probe('openrouter-images', [VECTOR])
    expect(problems).toEqual([])
    expect(lines.filter((line) => line.startsWith('finding:'))).toEqual([
      'finding: recraft/recraft-vector-x (one SVG document), document 1: 3 elements, ' +
        '2 subpaths, 14 bytes of path data; <style> yes, <text> no, <use> no',
    ])
  })

  it('reports a document the core refuses for its DOCTYPE, with its first bytes', async () => {
    const document = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd"><svg/>'
    captureRequests(() => answer(svg(document), 'image/svg+xml', 0.08))
    const { lines, problems } = await probe('openrouter-images', [VECTOR])
    expect(problems).toEqual([
      'recraft/recraft-vector-x (one SVG document): LLMDispatchError(PROVIDER_FAILED), final attempt malformed_response',
    ])
    expect(lines).toEqual([
      expect.stringMatching(/^finding: .*the core's SVG document check refused/),
      `document 1: ${String(document.length)} bytes; it carries a DOCTYPE before its root`,
      `document 1: its first 200 bytes: ${JSON.stringify(document)}`,
    ])
  })

  it('omits the key from the first bytes of a refused document', async () => {
    const document = `<!DOCTYPE svg><svg>${KEY}</svg>`
    captureRequests(() => answer(svg(document), 'image/svg+xml', 0.08))
    const { lines } = await probe('openrouter-images', [VECTOR])
    expect(lines[2]).toBe(
      `document 1: its first 200 bytes: ${JSON.stringify(`<!DOCTYPE svg><svg>${OMITTED_RUN}</svg>`)}`,
    )
    expect(lines.join('\n')).not.toContain(KEY.slice(10, 18))
  })

  it('withholds the first bytes of a refused document that still carry key material', async () => {
    const pieces = (KEY.match(/.{1,12}/g) ?? []).join(' ')
    const document = `<!DOCTYPE svg><svg>${pieces}</svg>`
    captureRequests(() => answer(svg(document), 'image/svg+xml', 0.08))
    const { lines } = await probe('openrouter-images', [VECTOR])
    expect(lines[2]).toBe(
      'document 1: its first 200 bytes are withheld: they may carry key material',
    )
    expect(lines.join('\n')).not.toContain(KEY.slice(10, 18))
  })

  it('says so when the adapter, not the core, refused the answer', async () => {
    captureRequests(() => answer(base64(jpeg(4, 4)), 'image/jpeg', 0.08))
    const { lines, problems } = await probe('openrouter-images', [VECTOR])
    expect(problems).toHaveLength(1)
    expect(lines).toEqual([expect.stringMatching(/^finding: .*the adapter refused the answer/)])
  })
})
