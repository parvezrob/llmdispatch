/**
 * The live check's image and SVG probes, and what each one asserts about what came back.
 *
 * A probe is one `run()` of an operation with `format: 'image'` or `format: 'svg'`, routed to a
 * built-in adapter and a real model. The core has already read every image's header and run its
 * SVG document check by the time `run()` resolves; the probe checks the result again from the
 * outside, with a header reader of its own, so the claim "the dimensions an adopter receives
 * are the image's own" is tested end to end rather than taken from the code that makes it.
 *
 * Imports nothing, so the parent can validate its probe table with `readProbes` before any
 * child starts, and the tests can drive `runProbes` with the package's sources and a scripted
 * `fetch`. The runner hands in the package and Zod.
 *
 * What a probe prints: model names, counts, media types, pixel sizes, byte sizes, latency,
 * token counts, a reported cost, and the shape of an SVG document as counts and yes-or-no
 * answers (`describeSvgShape`). Never a prompt, an image, or a response body, with one
 * deliberate exception: when the core refuses an SVG document, the first 200 bytes of that
 * document are printed as a JSON string. Before printing, every run of 16 or more characters
 * from the base64, base64url and hex alphabets (`A-Z`, `a-z`, `0-9`, `+`, `/`, `=`, `_`, `-`)
 * is replaced with `[run omitted]`, so no encoded value long enough to be a credential passes
 * through, whatever encoding or prefix it carries. As a second line of defence the preview is
 * withheld altogether when what remains still holds an eight-character run of this process's
 * key, of its base64 or of its hex encoding, or anything shaped like a key. What remains still
 * answers the question the preview is for: whether the prolog carries a DOCTYPE, a processing
 * instruction, an XML declaration or another root. A document a model generated from a fixed
 * prompt holds nothing of the maintainer's.
 *
 * @module
 */

/** The core's SVG response caps (spec §3 point 4c), restated here to be checked from outside. */
export const SVG_CAPS = Object.freeze({
  count: 16,
  perDocument: 10_000_000,
  perResponse: 40_000_000,
})

/** How much of a refused SVG document is shown. */
const PREVIEW_BYTES = 200

/**
 * Generous next to the 120 000 ms the README suggests: a timeout here is reported as a failure,
 * and the point of the run is to learn what the provider does, not to race it.
 */
const PROBE_TIMEOUT_MS = 180_000

/** The prompts: one sentence each, asking for a subject with nothing behind it. */
const RASTER_PROMPT =
  'A single red apple with a green leaf, centred, isolated, with nothing behind it.'
const SVG_PROMPT = 'A flat icon of a single red apple with a green leaf.'

/**
 * The adapters a probe may run on, each built from the one key its process holds and the
 * factory options the probe names (only `openaiImages` has any: `quality`).
 */
const FACTORIES = {
  gemini: (llmdispatch, apiKey) =>
    llmdispatch.gemini({ apiKey: () => Promise.resolve(apiKey) }),
  'openai-images': (llmdispatch, apiKey, options) =>
    llmdispatch.openaiImages({ ...options, apiKey: () => Promise.resolve(apiKey) }),
  'openrouter-images': (llmdispatch, apiKey) =>
    llmdispatch.openrouterImages({ apiKey: () => Promise.resolve(apiKey) }),
}

/** The factory options a probe table may set. */
const ADAPTER_OPTIONS = ['quality']

/** The adapter names a probe table may use. */
export const IMAGE_ADAPTERS = Object.freeze(Object.keys(FACTORIES))

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const EXPECTATIONS = ['mediaType', 'alpha', 'pixels', 'usage', 'reportedCost', 'countProbe']

/**
 * A probe table read back from JSON, or `null` with the reason pushed into `problems`.
 *
 * Shape only: whether a model takes a knob is the provider's answer to give, and the core
 * validates the knobs themselves when the switch is built.
 */
export function readProbes(json, problems) {
  let value
  try {
    value = JSON.parse(json)
  } catch {
    problems.push('the probe table is not JSON')
    return null
  }
  if (!Array.isArray(value) || value.length === 0) {
    problems.push('the probe table is not a non-empty array')
    return null
  }
  for (const [index, probe] of value.entries()) {
    const at = `probe ${String(index + 1)}`
    if (probe === null || typeof probe !== 'object') {
      problems.push(`${at}: not an object`)
      continue
    }
    if (typeof probe.label !== 'string' || probe.label === '') problems.push(`${at}: no label`)
    if (typeof probe.model !== 'string' || probe.model === '') problems.push(`${at}: no model`)
    if (probe.format !== 'image' && probe.format !== 'svg') {
      problems.push(`${at}: format is neither 'image' nor 'svg'`)
    }
    const knobs = probe.format === 'svg' ? probe.svg : probe.image
    if (knobs !== undefined && (knobs === null || typeof knobs !== 'object')) {
      problems.push(`${at}: its knobs are not an object`)
    }
    const expect = probe.expect ?? {}
    if (expect === null || typeof expect !== 'object') {
      problems.push(`${at}: expect is not an object`)
      continue
    }
    for (const name of Object.keys(expect)) {
      if (!EXPECTATIONS.includes(name)) problems.push(`${at}: unknown expectation '${name}'`)
    }
    const options = probe.adapterOptions ?? {}
    if (options === null || typeof options !== 'object') {
      problems.push(`${at}: adapterOptions is not an object`)
      continue
    }
    for (const name of Object.keys(options)) {
      if (!ADAPTER_OPTIONS.includes(name))
        problems.push(`${at}: unknown adapter option '${name}'`)
    }
  }
  return problems.length === 0 ? value : null
}

// --- reading what came back ---

/**
 * Base64 decoded, or `null` when the string is not canonical standard base64: decoding and
 * re-encoding must give the string back, so stray characters and loose padding both fail.
 */
export function decodeBase64(data) {
  if (typeof data !== 'string' || data === '') return null
  const bytes = Buffer.from(data, 'base64')
  return bytes.toString('base64') === data ? bytes : null
}

function be32(bytes, at) {
  return bytes.readUInt32BE(at)
}

function ascii(bytes, start, end) {
  return bytes.subarray(start, end).toString('latin1')
}

/**
 * The container, pixel size, and whether an alpha channel is declared, read from the first
 * bytes of a PNG, JPEG or WebP file; `null` when they are none of these.
 *
 * Independent of the core's reader on purpose, so the two cross-check each other. For a PNG
 * the alpha question is the IHDR colour type (4 and 6 carry alpha) or a `tRNS` chunk before
 * the first `IDAT`; for a WebP it is the VP8X or VP8L alpha flag; a JPEG never has one.
 * Declared, not measured: whether any pixel is actually transparent is not read.
 */
export function readRasterHeader(bytes) {
  if (bytes.length >= 26 && be32(bytes, 0) === 0x89504e47 && ascii(bytes, 12, 16) === 'IHDR') {
    const colourType = bytes[25]
    let alpha = colourType === 4 || colourType === 6
    // Walk the chunks after IHDR for a transparency chunk, stopping at the image data.
    let at = 33
    while (!alpha && at + 8 <= bytes.length) {
      const type = ascii(bytes, at + 4, at + 8)
      if (type === 'IDAT' || type === 'IEND') break
      if (type === 'tRNS') alpha = true
      at += 12 + be32(bytes, at)
    }
    return { mediaType: 'image/png', width: be32(bytes, 16), height: be32(bytes, 20), alpha }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes)
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return readWebp(bytes)
  }
  return null
}

/** Start-of-frame markers: every SOFn but DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker) {
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  )
}

function readJpeg(bytes) {
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes before a marker, and the markers that carry no length (a repeated SOI too).
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = bytes.readUInt16BE(at + 2)
    if (isStartOfFrame(marker)) {
      // The frame header must fit inside both the segment and the bytes.
      if (length < 7 || at + 2 + length > bytes.length) return null
      return {
        mediaType: 'image/jpeg',
        width: bytes.readUInt16BE(at + 7),
        height: bytes.readUInt16BE(at + 5),
        alpha: false,
      }
    }
    at += 2 + length
  }
  return null
}

function readWebp(bytes) {
  const fourcc = ascii(bytes, 12, 16)
  if (fourcc === 'VP8 ' && bytes.length >= 30) {
    return {
      mediaType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      alpha: false,
    }
  }
  if (fourcc === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21)
    return {
      mediaType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      alpha: ((bits >>> 28) & 1) === 1,
    }
  }
  if (fourcc === 'VP8X' && bytes.length >= 30) {
    return {
      mediaType: 'image/webp',
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
      alpha: (bytes[20] & 0x10) !== 0,
    }
  }
  return null
}

/**
 * The text with every closed comment (`<!--` to the next `-->`) removed, and an unclosed one
 * left in place with everything after it: what `/<!--[\s\S]*?-->/g` removes, in one pass.
 * The regular expression rescans to the end for every `<!--` it cannot close, so a document
 * that opens many comments and closes none costs it quadratic time; this costs one scan.
 */
export function withoutComments(text) {
  let kept = ''
  let at = 0
  for (;;) {
    const open = text.indexOf('<!--', at)
    if (open === -1) break
    const close = text.indexOf('-->', open + 4)
    // With no `-->` after this opening there is none after any later one either.
    if (close === -1) break
    kept += text.slice(at, open)
    at = close + 3
  }
  return kept + text.slice(at)
}

/**
 * Why this script would refuse an SVG document, or `null` when it sees nothing wrong.
 *
 * A rough reading, for the report only; the core's tokenized check (spec §6) is the one that
 * decides. Comments are removed before it looks for the root or a DOCTYPE, so a comment that
 * mentions either is not mistaken for it.
 */
export function diagnoseSvg(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return 'it is not valid UTF-8'
  }
  if (text.includes('\u0000')) return 'it carries a NUL character'
  const uncommented = withoutComments(text)
  const root = /<svg[\s/>]/.exec(uncommented)
  // Only the prolog is read, as the core stops at the root: a comment left open after it is
  // the document's business, not this check's.
  const prolog = root === null ? uncommented : uncommented.slice(0, root.index)
  if (prolog.includes('<!--')) return 'it carries a comment that never closes'
  if (root === null) return 'it has no <svg root element'
  if (/<!DOCTYPE/i.test(prolog)) return 'it carries a DOCTYPE before its root'
  if (/<!/.test(prolog)) return 'it carries a markup declaration before its root'
  if (/<\?(?!xml[\s?])/.test(prolog)) {
    return 'it carries a processing instruction before its root'
  }
  const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(prolog)?.[1]
  if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') {
    return 'its XML declaration names an encoding other than UTF-8'
  }
  return null
}

/**
 * The shape of an SVG document, for the report: how many elements it opens, how many subpaths
 * its paths draw (each `M` or `m` in a `d` attribute), how many bytes of path data those
 * attributes hold, and whether it uses `<style>`, `<text>` or `<use>`. Plain string scanning
 * after comments are removed, so a rough count rather than a parse; what it answers is numbers
 * and booleans, never any of the document's text.
 */
export function describeSvgShape(bytes) {
  const text = withoutComments(new TextDecoder('utf-8').decode(bytes))
  let subpaths = 0
  let pathBytes = 0
  for (const match of text.matchAll(/\sd\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const data = match[1] ?? match[2] ?? ''
    pathBytes += Buffer.byteLength(data, 'utf8')
    subpaths += (data.match(/[Mm]/g) ?? []).length
  }
  return {
    elements: (text.match(/<[A-Za-z]/g) ?? []).length,
    subpaths,
    pathBytes,
    style: /<style[\s/>]/.test(text),
    text: /<text[\s/>]/.test(text),
    use: /<use[\s/>]/.test(text),
  }
}

/** The shape of one document as the finding line the SVG probe prints. */
function svgShapeFinding(at, bytes) {
  const shape = describeSvgShape(bytes)
  const uses = ['style', 'text', 'use'].map((name) => `<${name}> ${shape[name] ? 'yes' : 'no'}`)
  return (
    `finding: ${at}: ${String(shape.elements)} elements, ${String(shape.subpaths)} subpaths, ` +
    `${String(shape.pathBytes)} bytes of path data; ${uses.join(', ')}`
  )
}

/** Something shaped like a provider key: an `sk-` style token or a Google API key. */
const KEY_SHAPE = new RegExp(
  ['\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}', 'AI' + 'za[0-9A-Za-z_-]{20,}'].join('|'),
)

/**
 * Whether `text` holds any eight-character run of a secret, of its base64 or of its hex
 * encoding, or anything shaped like a key.
 */
export function carriesKeyMaterial(text, secrets) {
  for (const secret of secrets) {
    if (secret === '') continue
    const bytes = Buffer.from(secret, 'utf8')
    for (const form of [secret, bytes.toString('base64'), bytes.toString('hex')]) {
      const run = Math.min(8, form.length)
      for (let start = 0; start + run <= form.length; start += 1) {
        if (text.includes(form.slice(start, start + run))) return true
      }
    }
  }
  return KEY_SHAPE.test(text)
}

/** A run long enough to be an encoded credential, in any of the base64, base64url or hex forms. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{16,}/g
/** What a long run is replaced with: fixed, so it says nothing about what it replaced. */
export const OMITTED_RUN = '[run omitted]'

/**
 * The first bytes of a document as a JSON string with every long run omitted, or `null` when
 * what remains may still carry key material.
 */
export function previewIfSafe(bytes, secrets) {
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, PREVIEW_BYTES))
  const shown = text.replace(LONG_RUN, OMITTED_RUN)
  return carriesKeyMaterial(shown, secrets) ? null : JSON.stringify(shown)
}

// --- checking a result ---

/**
 * Checks the images of a successful image run. Returns the lines worth reporting; failures go
 * into `problems`.
 */
export function checkImages(label, images, probe, problems) {
  const notes = []
  const expect = probe.expect ?? {}
  const wanted = probe.image?.count ?? 1
  if (images.length !== wanted) {
    const line = `asked for ${String(wanted)} image(s), got ${String(images.length)}`
    if (expect.countProbe === true) notes.push(`finding: ${label}: ${line}`)
    else problems.push(`${label}: ${line}`)
  } else if (expect.countProbe === true) {
    notes.push(`finding: ${label}: asked for ${String(wanted)} image(s) and got them all`)
  }
  const allowed = expect.mediaType === undefined ? RASTER_TYPES : [expect.mediaType]
  for (const [index, image] of images.entries()) {
    const at = `${label}, image ${String(index + 1)}`
    if (image.type !== 'file') problems.push(`${at}: type was not 'file'`)
    if (!allowed.includes(image.mediaType)) {
      problems.push(
        `${at}: media type ${String(image.mediaType)}, expected ${allowed.join(' or ')}`,
      )
    }
    const bytes = decodeBase64(image.data)
    if (bytes === null) {
      problems.push(`${at}: the data is not canonical base64`)
      continue
    }
    const header = readRasterHeader(bytes)
    if (header === null) {
      problems.push(`${at}: the bytes are not a PNG, JPEG or WebP this script can read`)
      continue
    }
    if (header.mediaType !== image.mediaType) {
      problems.push(
        `${at}: labelled ${String(image.mediaType)} but the bytes are ${header.mediaType}`,
      )
    }
    if (header.width !== image.width || header.height !== image.height) {
      problems.push(
        `${at}: stated ${String(image.width)}x${String(image.height)} but the header says ` +
          `${String(header.width)}x${String(header.height)}`,
      )
    }
    const pixels = `${String(header.width)}x${String(header.height)}`
    if (expect.pixels !== undefined && pixels !== expect.pixels) {
      problems.push(`${at}: ${pixels}, expected ${String(expect.pixels)}`)
    }
    if (expect.alpha === true && !header.alpha) {
      problems.push(`${at}: no alpha channel, though the request asked for transparency`)
    }
    notes.push(
      `image ${String(index + 1)}: ${header.mediaType} ${pixels}, ${String(bytes.length)} bytes, ` +
        (header.alpha ? 'alpha channel' : 'no alpha channel'),
    )
  }
  return notes
}

/**
 * Checks the documents of a successful svg run. Returns the lines worth reporting; failures go
 * into `problems`.
 */
export function checkSvgs(label, svgs, probe, problems) {
  const notes = []
  const wanted = probe.svg?.count ?? 1
  if (svgs.length !== wanted) {
    problems.push(
      `${label}: asked for ${String(wanted)} document(s), got ${String(svgs.length)}`,
    )
  }
  if (svgs.length > SVG_CAPS.count)
    problems.push(`${label}: more documents than the core's cap`)
  let total = 0
  for (const [index, svg] of svgs.entries()) {
    const at = `${label}, document ${String(index + 1)}`
    if (svg.type !== 'svg') problems.push(`${at}: type was not 'svg'`)
    if (svg.mediaType !== 'image/svg+xml')
      problems.push(`${at}: media type was not image/svg+xml`)
    const length = typeof svg.data === 'string' ? svg.data.length : 0
    total += length
    if (length > SVG_CAPS.perDocument) problems.push(`${at}: over the per-document cap`)
    const bytes = decodeBase64(svg.data)
    if (bytes === null) {
      problems.push(`${at}: the data is not canonical base64`)
      continue
    }
    const reason = diagnoseSvg(bytes)
    if (reason !== null) problems.push(`${at}: the core accepted it, but ${reason}`)
    notes.push(
      `document ${String(index + 1)}: ${String(bytes.length)} bytes ` +
        `(${String(length)} base64 characters)`,
    )
    notes.push(svgShapeFinding(at, bytes))
  }
  if (total > SVG_CAPS.perResponse) problems.push(`${label}: over the per-response cap`)
  return notes
}

/** Token counts and cost of a run's final attempt, as one line, and the problems they show. */
function checkAccounting(label, attempt, probe, problems) {
  const expect = probe.expect ?? {}
  const { usage } = attempt
  let line
  if (usage === null) {
    line = 'usage not reported'
    if (expect.usage === true) problems.push(`${label}: usage was null`)
  } else {
    const split =
      usage.imageOutputTokens === undefined
        ? 'no image token split'
        : `of which ${String(usage.imageOutputTokens)} image`
    line = `usage ${String(usage.inputTokens)} in, ${String(usage.outputTokens)} out (${split})`
  }
  // No pricing table is given to the switch, so any cost an attempt carries is the provider's.
  if (attempt.costUsd === null) {
    line += ', no reported cost'
    if (expect.reportedCost === true) problems.push(`${label}: no cost was reported`)
  } else {
    line += `, reported cost $${attempt.costUsd.toFixed(4)}`
  }
  return line
}

// --- running ---

/** The failure in terms of what it was, never what it said. */
function describeFailure(error, llmdispatch) {
  if (error instanceof llmdispatch.LLMDispatchError) {
    const attempts = error.attempts ?? []
    const last = attempts[attempts.length - 1]
    if (last === undefined) return `LLMDispatchError(${error.code})`
    const status = last.status === undefined ? '' : `, HTTP ${String(last.status)}`
    return `LLMDispatchError(${error.code}), final attempt ${last.outcome}${status}`
  }
  if (error instanceof Error) return `${error.name} (message withheld)`
  return `a thrown ${typeof error}`
}

/** The final attempt's outcome on a classified failure, or `null` for any other throw. */
function finalOutcome(error, llmdispatch) {
  if (!(error instanceof llmdispatch.LLMDispatchError)) return null
  const attempts = error.attempts ?? []
  return attempts[attempts.length - 1]?.outcome ?? null
}

/**
 * A provider that hands every call to `provider` and keeps what came back.
 *
 * The core consumes a response and, when it refuses an SVG document, keeps nothing of it; this
 * is how a refused document can still be diagnosed. It changes nothing on the way through:
 * the same request goes in, the same response or the same thrown value comes out.
 */
function recording(provider, seen) {
  const wrap = (prepared) => ({
    async complete(request) {
      try {
        const response = await prepared.complete(request)
        seen.push({ response })
        return response
      } catch (error) {
        seen.push({ error })
        throw error
      }
    },
  })
  return {
    async prepare() {
      return wrap(provider.prepare === undefined ? provider : await provider.prepare())
    },
    complete: (request) => wrap(provider).complete(request),
  }
}

/** A one-operation switch for one probe, with no quota, no fallback and no pricing table. */
function probeSwitch(context, probe, provider) {
  const { llmdispatch, z } = context
  const svg = probe.format === 'svg'
  const operation = {
    input: z.object({}),
    output: svg ? llmdispatch.svgOutputSchema : llmdispatch.imageOutputSchema,
    prompt: () => (svg ? SVG_PROMPT : RASTER_PROMPT),
    format: probe.format,
    timeoutMs: PROBE_TIMEOUT_MS,
    defaultRoute: { provider: 'probe', model: probe.model },
  }
  const knobs = svg ? probe.svg : probe.image
  if (knobs !== undefined) operation[svg ? 'svg' : 'image'] = knobs
  return llmdispatch.createSwitch({
    providers: { probe: provider },
    operations: llmdispatch.defineOperations({
      probe: llmdispatch.defineOperation(operation),
    }),
    stores: llmdispatch.memoryStores(),
  })
}

/** What can be said about an SVG answer the core refused, from the recorded response. */
function explainSvgRefusal(label, seen, context) {
  const lines = []
  const last = seen[seen.length - 1]
  const svgs = last?.response?.kind === 'complete' ? last.response.svgs : undefined
  if (!Array.isArray(svgs) || svgs.length === 0) {
    lines.push(
      `finding: ${label}: the adapter refused the answer before the core saw it ` +
        '(a media type other than image/svg+xml, a cap, or the base64 grammar)',
    )
    return lines
  }
  lines.push(
    `finding: ${label}: the core's SVG document check refused what the model returned, so SVG ` +
      'output does not work with this model as it stands',
  )
  let shown = false
  for (const [index, svg] of svgs.entries()) {
    const at = `document ${String(index + 1)}`
    const bytes = decodeBase64(svg.data)
    if (bytes === null) {
      lines.push(`${at}: not canonical base64`)
      continue
    }
    const reason = diagnoseSvg(bytes)
    lines.push(
      `${at}: ${String(bytes.length)} bytes; ` +
        (reason ??
          "this script's rough reading finds nothing; the core's prolog check differs"),
    )
    if (shown) continue
    shown = true
    const preview = previewIfSafe(bytes, context.secrets)
    lines.push(
      preview === null
        ? `${at}: its first ${String(PREVIEW_BYTES)} bytes are withheld: ` +
            'they may carry key material'
        : `${at}: its first ${String(PREVIEW_BYTES)} bytes: ${preview}`,
    )
  }
  return lines
}

/**
 * One probe: the run, then every check its result has to pass. Returns the final attempt's
 * outcome when the run threw a classified failure, `'failed'` for any other throw, and `null`
 * when the run came back (its checks may still have found problems).
 */
async function runProbe(context, probe, problems) {
  const { llmdispatch, write } = context
  const label = `${probe.model} (${probe.label})`
  const seen = []
  const adapter = context.factory(llmdispatch, context.apiKey, probe.adapterOptions ?? {})
  const provider = recording(adapter, seen)
  const started = Date.now()
  let result
  try {
    result = await probeSwitch(context, probe, provider).run(
      'probe',
      { input: {} },
      { signal: context.signal },
    )
  } catch (error) {
    const outcome = finalOutcome(error, llmdispatch)
    if (probe.expect?.countProbe === true && outcome === 'invalid_request') {
      await settleCount(context, probe, label, describeFailure(error, llmdispatch), problems)
      return outcome
    }
    problems.push(`${label}: ${describeFailure(error, llmdispatch)}`)
    if (probe.format === 'svg' && outcome === 'malformed_response') {
      for (const line of explainSvgRefusal(label, seen, context)) write(line)
    }
    return outcome ?? 'failed'
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const attempt = result.attempts[result.attempts.length - 1]
  const notes =
    probe.format === 'svg'
      ? checkSvgs(label, result.data.svgs, probe, problems)
      : checkImages(label, result.data.images, probe, problems)
  write(
    `${label}: answered in ${seconds} s, ${checkAccounting(label, attempt, probe, problems)}`,
  )
  // Findings start the line, as the docs describe them; the rest is indented under the probe.
  for (const note of notes) write(note.startsWith('finding:') ? note : `  ${note}`)
  return null
}

/**
 * A count probe answered `invalid_request`: asks once more for a single image, and only then
 * says what the 400 meant. A 400 on the single image too says the request failed for some
 * other reason, so the count question stays open and the probe fails.
 */
async function settleCount(context, probe, label, failure, problems) {
  const count = String(probe.image?.count)
  context.write(`${label}: count ${count} answered ${failure}; asking for one image instead`)
  const single = { ...probe.image }
  delete single.count
  const retry = {
    ...probe,
    label: `${probe.label}, one image instead`,
    image: single,
    expect: { ...probe.expect, countProbe: false },
  }
  const outcome = await runProbe(context, retry, problems)
  if (outcome === null) {
    context.write(
      `finding: ${label}: the model refused count ${count} and answered one image, so it takes ` +
        'no candidate count',
    )
  } else if (outcome === 'invalid_request') {
    context.write(
      `finding: ${label}: the single image was refused the same way, so the 400 is not ` +
        'specific to count; whether the model takes a candidate count is unsettled',
    )
  } else {
    context.write(
      `finding: ${label}: the single image failed too, so whether the model takes a ` +
        'candidate count is unsettled',
    )
  }
}

/**
 * Runs every probe on one adapter, in order, and returns the problems found.
 *
 * @param context `llmdispatch` and `z` are the package and Zod; `adapter` names the factory;
 *   `apiKey` is the one key this process holds; `probes` is what `readProbes` returned;
 *   `signal` cancels the call in flight; `write` takes one line of output.
 */
export async function runProbes(context) {
  const problems = []
  const factory = FACTORIES[context.adapter]
  if (factory === undefined) return [`'${String(context.adapter)}' is not an image adapter`]
  const probeContext = { ...context, factory, secrets: [context.apiKey] }
  for (const probe of context.probes) await runProbe(probeContext, probe, problems)
  return problems
}
