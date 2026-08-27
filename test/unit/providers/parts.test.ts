/**
 * How each built-in adapter turns `ProviderRequest.parts` into its wire body (spec §5c):
 * the mapped shape per part kind, order preserved, the single-text form pinned to the exact
 * bytes it has always serialized, and file data and filenames kept out of every error path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { anthropic } from '../../../src/providers/anthropic'
import { gemini } from '../../../src/providers/gemini'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import type { ContentPart, PreparedProvider, ProviderRequest } from '../../../src/types'
import type { CapturedRequest } from './helpers'
import {
  baseRequest,
  captureRequests,
  installFetch,
  jsonResponse,
  withPrepared,
} from './helpers'

const PDF_DATA = 'JVBERi0xLjQK'
const PNG_DATA = 'iVBORw0KGgo='
const GIF_DATA = 'R0lGODlhAQAB'

const DATA_SENTINEL = 'U0VOVElORUxfREFUQV84YjJm'
const FILENAME_SENTINEL = 'SENTINEL_FILENAME_4d7e.pdf'

const TEXT: ContentPart = { type: 'text', text: 'read this' }
const PDF: ContentPart = {
  type: 'file',
  mediaType: 'application/pdf',
  data: PDF_DATA,
  filename: 'report.pdf',
}
const UNNAMED_PDF: ContentPart = { type: 'file', mediaType: 'application/pdf', data: PDF_DATA }
const PNG: ContentPart = { type: 'file', mediaType: 'image/png', data: PNG_DATA }
const GIF: ContentPart = { type: 'file', mediaType: 'image/gif', data: GIF_DATA }
const SENTINEL_PDF: ContentPart = {
  type: 'file',
  mediaType: 'application/pdf',
  data: DATA_SENTINEL,
  filename: FILENAME_SENTINEL,
}

const JSON_OBJECT: ProviderRequest['responseFormat'] = { type: 'json', topLevel: 'object' }

interface Adapter {
  name: string
  /** A 200 body this adapter reads as a normal completion. */
  ok: unknown
  build: () => Promise<PreparedProvider['complete']>
  /** The mapped parts, wherever this adapter puts them in its body. */
  content: (body: Record<string, unknown>) => unknown
  /** The exact body a single-text request has always serialized to. */
  golden: string
  /** The mapped content of the lone empty text part, which is a legal prompt. */
  emptyText: unknown
}

function messageContent(body: Record<string, unknown>): unknown {
  const messages = body.messages as { content: unknown }[]
  return messages[0]!.content
}

const ANTHROPIC: Adapter = {
  name: 'anthropic',
  ok: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
  build: () => withPrepared(anthropic({ apiKey: () => 'k' })),
  content: messageContent,
  golden:
    '{"model":"test-model","max_tokens":4096,"messages":[{"role":"user","content":"hello"}]}',
  emptyText: '',
}

const OPENAI: Adapter = {
  name: 'openai-compatible',
  ok: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
  build: () => withPrepared(openaiCompatible({ apiKey: () => 'k' })),
  content: messageContent,
  golden: '{"model":"test-model","messages":[{"role":"user","content":"hello"}]}',
  emptyText: '',
}

const GEMINI: Adapter = {
  name: 'gemini',
  ok: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
  build: () => withPrepared(gemini({ apiKey: () => 'k' })),
  content: (body) => {
    const contents = body.contents as { parts: unknown }[]
    return contents[0]!.parts
  },
  golden: '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}',
  emptyText: [{ text: '' }],
}

const ADAPTERS = [ANTHROPIC, OPENAI, GEMINI]

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What `call` rejected with, or `null` when it resolved, which no caller here expects. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => null,
    (thrown: unknown) => thrown,
  )
}

/** Dispatches one request through `adapter` and returns what fetch was handed. */
async function dispatch(
  adapter: Adapter,
  overrides: Partial<ProviderRequest>,
): Promise<CapturedRequest> {
  const { requests } = captureRequests(() => jsonResponse(200, adapter.ok))
  const complete = await adapter.build()
  await complete(baseRequest(overrides))
  return requests[0]!
}

/** The parts of `overrides` as `adapter` mapped them. */
async function contentOf(adapter: Adapter, parts: readonly ContentPart[]): Promise<unknown> {
  const captured = await dispatch(adapter, { parts })
  return adapter.content(captured.body as Record<string, unknown>)
}

describe('anthropic content blocks', () => {
  it('sends a lone text part as a plain string', async () => {
    expect(await contentOf(ANTHROPIC, [{ type: 'text', text: 'say hi' }])).toBe('say hi')
  })

  it('sends a PDF part as a base64 document block', async () => {
    expect(await contentOf(ANTHROPIC, [PDF])).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_DATA },
      },
    ])
  })

  it('sends an image part as a base64 image block carrying its media type', async () => {
    expect(await contentOf(ANTHROPIC, [PNG])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
    ])
  })

  it('keeps text and file blocks in the order the parts arrived', async () => {
    expect(await contentOf(ANTHROPIC, [TEXT, PDF, PNG])).toEqual([
      { type: 'text', text: 'read this' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_DATA },
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
    ])
  })

  it('sends multiple text parts as one text block each', async () => {
    expect(
      await contentOf(ANTHROPIC, [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
  })

  it('never puts a filename on the wire', async () => {
    const captured = await dispatch(ANTHROPIC, { parts: [PDF] })
    expect(captured.rawBody).not.toContain('report.pdf')
  })

  it('stays prompt-only for json format beside a file part', async () => {
    const captured = await dispatch(ANTHROPIC, {
      parts: [TEXT, PNG],
      responseFormat: JSON_OBJECT,
    })
    const body = captured.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model'])
  })
})

describe('openai-compatible content parts', () => {
  it('sends a lone text part as a plain string', async () => {
    expect(await contentOf(OPENAI, [{ type: 'text', text: 'say hi' }])).toBe('say hi')
  })

  it('sends an image part as a data-URL image_url part', async () => {
    expect(await contentOf(OPENAI, [PNG])).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
    ])
  })

  it('sends a PDF part as a file part carrying the part filename', async () => {
    expect(await contentOf(OPENAI, [PDF])).toEqual([
      {
        type: 'file',
        file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF_DATA}` },
      },
    ])
  })

  it('falls back to document.pdf when the part carries no filename', async () => {
    expect(await contentOf(OPENAI, [UNNAMED_PDF])).toEqual([
      {
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:application/pdf;base64,${PDF_DATA}`,
        },
      },
    ])
  })

  it('keeps text and file parts in the order the parts arrived', async () => {
    expect(await contentOf(OPENAI, [TEXT, PDF, PNG])).toEqual([
      { type: 'text', text: 'read this' },
      {
        type: 'file',
        file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF_DATA}` },
      },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
    ])
  })

  it('sends multiple text parts as one text part each', async () => {
    expect(
      await contentOf(OPENAI, [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
  })

  it('still sends response_format for json format beside a file part', async () => {
    const captured = await dispatch(OPENAI, { parts: [TEXT, PNG], responseFormat: JSON_OBJECT })
    const body = captured.body as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('gemini content parts', () => {
  it('sends a lone text part as a single text entry', async () => {
    expect(await contentOf(GEMINI, [{ type: 'text', text: 'say hi' }])).toEqual([
      { text: 'say hi' },
    ])
  })

  it('sends a file part as snake_case inline_data', async () => {
    expect(await contentOf(GEMINI, [PDF])).toEqual([
      { inline_data: { mime_type: 'application/pdf', data: PDF_DATA } },
    ])
  })

  it('sends an image part through the same inline_data form', async () => {
    expect(await contentOf(GEMINI, [PNG])).toEqual([
      { inline_data: { mime_type: 'image/png', data: PNG_DATA } },
    ])
  })

  // Gemini's image guide lists png/jpeg/webp/heic/heif; a gif goes on the wire unchanged
  // and surfaces whatever Gemini answers (§5c).
  it('sends a gif part unchanged rather than refusing it', async () => {
    expect(await contentOf(GEMINI, [GIF])).toEqual([
      { inline_data: { mime_type: 'image/gif', data: GIF_DATA } },
    ])
  })

  it('keeps text and file entries in the order the parts arrived', async () => {
    expect(await contentOf(GEMINI, [TEXT, PDF, PNG])).toEqual([
      { text: 'read this' },
      { inline_data: { mime_type: 'application/pdf', data: PDF_DATA } },
      { inline_data: { mime_type: 'image/png', data: PNG_DATA } },
    ])
  })

  it('sends multiple text parts as one entry each', async () => {
    expect(
      await contentOf(GEMINI, [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toEqual([{ text: 'one' }, { text: 'two' }])
  })

  it('never puts a filename on the wire', async () => {
    const captured = await dispatch(GEMINI, { parts: [PDF] })
    expect(captured.rawBody).not.toContain('report.pdf')
  })

  it('still sets responseMimeType for json format beside a file part', async () => {
    const captured = await dispatch(GEMINI, { parts: [TEXT, PNG], responseFormat: JSON_OBJECT })
    const body = captured.body as Record<string, unknown>
    const config = body.generationConfig as Record<string, unknown>
    expect(config.responseMimeType).toBe('application/json')
  })
})

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} on a text-only request`, () => {
    // Parsed-JSON equality would pass however the fields moved: the single-text body is
    // pinned to its exact serialization, so no multimodal branch can shift it.
    it('serializes the exact body it has always sent', async () => {
      const captured = await dispatch(adapter, {})
      expect(captured.rawBody).toBe(adapter.golden)
    })

    it('serializes an empty text part, which is a legal prompt', async () => {
      expect(await contentOf(adapter, [{ type: 'text', text: '' }])).toEqual(adapter.emptyText)
    })
  })

  describe(`${adapter.name} on a failed request carrying a file part`, () => {
    it('keeps the file data and filename out of the thrown message', async () => {
      installFetch(() =>
        jsonResponse(400, { error: { message: `bad: ${DATA_SENTINEL} ${FILENAME_SENTINEL}` } }),
      )
      const complete = await adapter.build()
      const error = await rejectionOf(complete(baseRequest({ parts: [TEXT, SENTINEL_PDF] })))

      // The classification is asserted first: it is what proves the sweep below ran against
      // the adapter's own error rather than a resolved call or a stray assertion failure.
      expect(ProviderError.is(error)).toBe(true)
      const thrown = error as ProviderError
      expect(thrown.kind).toBe('invalid_request')
      expect(thrown.status).toBe(400)
      expect(thrown.message).not.toContain(DATA_SENTINEL)
      expect(thrown.message).not.toContain(FILENAME_SENTINEL)
      const own = JSON.stringify(Object.values(thrown))
      expect(own).not.toContain(DATA_SENTINEL)
      expect(own).not.toContain(FILENAME_SENTINEL)
    })
  })
}
