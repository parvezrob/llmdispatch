/**
 * The SVG document check (spec §6): the base64 grammar, strict UTF-8 over every byte, the
 * tokenized prolog, and the exact root, on the normative vectors, the bypass inputs that a
 * substring search would let through, the false refusals it would make, and a differential
 * property against an independent regular-expression oracle.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  MAX_RESPONSE_SVG_CHARACTERS,
  MAX_RESPONSE_SVGS,
  MAX_SVG_CHARACTERS,
  svgDocumentProblem,
} from '../../../src/core/svg-document'

function b64(bytes: readonly number[] | Uint8Array | string): string {
  return typeof bytes === 'string'
    ? Buffer.from(bytes, 'utf8').toString('base64')
    : Buffer.from(bytes).toString('base64')
}

function utf8(text: string): number[] {
  return [...Buffer.from(text, 'utf8')]
}

const BOM = [0xef, 0xbb, 0xbf]

function check(document: string | readonly number[]): ReturnType<typeof svgDocumentProblem> {
  return svgDocumentProblem(b64(document))
}

describe('the caps', () => {
  it('sit above the knob, and the aggregate above one document', () => {
    expect(MAX_RESPONSE_SVGS).toBe(16)
    expect(MAX_SVG_CHARACTERS).toBe(10_000_000)
    expect(MAX_RESPONSE_SVG_CHARACTERS).toBe(40_000_000)
    expect(MAX_SVG_CHARACTERS % 4).toBe(0)
  })
})

describe('accepted documents', () => {
  const accepted: { name: string; document: string | number[] }[] = [
    { name: 'a self-closing root', document: '<svg/>' },
    { name: 'an open root', document: '<svg>' },
    { name: 'a root followed by a line feed', document: '<svg\n' },
    { name: 'a root followed by a tab and attributes', document: '<svg\txmlns="x"></svg>' },
    {
      name: 'a CDATA section mentioning a DOCTYPE inside the root',
      document: '<svg><text><![CDATA[<!DOCTYPE]]></text></svg>',
    },
    {
      name: 'a comment mentioning an ENTITY inside the root',
      document: '<svg><!-- documentation mentioning <!ENTITY x> --></svg>',
    },
    {
      name: 'a byte order mark, a declaration, comments and the root',
      document: [
        ...BOM,
        ...utf8(
          '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- a -->\r\n\t<!---->  <svg/>',
        ),
      ],
    },
    {
      name: 'a lower-case encoding name',
      document: '<?xml version="1.0" encoding="utf-8"?><svg/>',
    },
    {
      name: 'a mixed-case encoding name',
      document: "<?xml version='1.1' encoding='Utf-8'?><svg/>",
    },
    { name: 'single quotes and spaced Eq', document: "<?xml version = '1.0' ?><svg/>" },
    { name: 'standalone yes', document: '<?xml version="1.0" standalone="yes"?><svg/>' },
    { name: 'a multi-digit minor version', document: '<?xml version="1.10"?><svg/>' },
    { name: 'a declaration then whitespace', document: '<?xml version="1.0"?>\n\n<svg>' },
    { name: 'a comment with single hyphens', document: '<!-- a-b - c --><svg/>' },
    { name: 'non-ASCII text after the root', document: '<svg><text>café ✓ 𝄞</text></svg>' },
    { name: 'the highest code point', document: '<svg>\u{10FFFF}</svg>' },
  ]
  for (const { name, document } of accepted) {
    it(`accepts ${name}`, () => {
      expect(check(document)).toBeNull()
    })
  }
})

describe('the base64 grammar', () => {
  it('rejects an empty document', () => {
    expect(svgDocumentProblem('')).toBe('base64')
  })

  it('rejects whitespace, a data-URL prefix, a bad alphabet and missing padding', () => {
    const data = b64('<svg/>')
    expect(svgDocumentProblem(`${data}\n`)).toBe('base64')
    expect(svgDocumentProblem(`data:image/svg+xml;base64,${data}`)).toBe('base64')
    expect(svgDocumentProblem(data.replace(/.$/, '-'))).toBe('base64')
    expect(svgDocumentProblem(b64('<svg>').replace(/=+$/, ''))).toBe('base64')
  })

  it('rejects a value that is not a string', () => {
    expect(svgDocumentProblem(undefined)).toBe('base64')
    expect(svgDocumentProblem(42)).toBe('base64')
  })

  it('checks the whole document, not a prefix', () => {
    const data = b64('<svg/>'.padEnd(400, ' '))
    expect(svgDocumentProblem(data)).toBeNull()
    expect(svgDocumentProblem(`${data.slice(0, -4)}*AAA`)).toBe('base64')
  })
})

describe('strict UTF-8', () => {
  const root = utf8('<svg>')
  const cases: { name: string; bytes: number[] }[] = [
    { name: 'a UTF-16 big-endian byte order mark', bytes: [0xfe, 0xff, ...root] },
    { name: 'a UTF-16 little-endian byte order mark', bytes: [0xff, 0xfe, ...root] },
    { name: 'UTF-16 without a byte order mark', bytes: [...b16('<svg/>')] },
    { name: 'a NUL before the root', bytes: [0x00, ...root] },
    { name: 'a NUL deep inside the root', bytes: [...root, ...utf8('<g/>'), 0x00, 0x41] },
    { name: 'a stray continuation byte', bytes: [...root, 0x80] },
    { name: 'a lone lead byte at the end', bytes: [...root, 0xc3] },
    { name: 'a truncated three-byte sequence', bytes: [...root, 0xe2, 0x82] },
    { name: 'a truncated four-byte sequence', bytes: [...root, 0xf0, 0x9f, 0x98] },
    { name: 'a lead byte followed by ASCII', bytes: [...root, 0xc3, 0x41] },
    { name: 'an overlong two-byte form (C0)', bytes: [...root, 0xc0, 0xaf] },
    { name: 'an overlong two-byte form (C1)', bytes: [...root, 0xc1, 0xbf] },
    { name: 'an overlong three-byte form', bytes: [...root, 0xe0, 0x80, 0xaf] },
    { name: 'an overlong four-byte form', bytes: [...root, 0xf0, 0x80, 0x80, 0xaf] },
    { name: 'a high surrogate', bytes: [...root, 0xed, 0xa0, 0x80] },
    { name: 'a low surrogate', bytes: [...root, 0xed, 0xbf, 0xbf] },
    { name: 'a code point above U+10FFFF', bytes: [...root, 0xf4, 0x90, 0x80, 0x80] },
    { name: 'an F5 lead byte', bytes: [...root, 0xf5, 0x80, 0x80, 0x80] },
    { name: 'an FF byte', bytes: [...root, 0xff] },
  ]
  for (const { name, bytes } of cases) {
    it(`rejects ${name}`, () => {
      expect(check(bytes)).toBe('encoding')
    })
  }

  it('accepts the edges of every multi-byte range', () => {
    const edges = [
      [0xc2, 0x80],
      [0xdf, 0xbf],
      [0xe0, 0xa0, 0x80],
      [0xed, 0x9f, 0xbf],
      [0xee, 0x80, 0x80],
      [0xf0, 0x90, 0x80, 0x80],
      [0xf4, 0x8f, 0xbf, 0xbf],
    ]
    for (const edge of edges) expect(check([...root, ...edge])).toBeNull()
  })

  function b16(text: string): Buffer {
    return Buffer.from(text, 'utf16le')
  }
})

describe('the prolog', () => {
  const malformed: { name: string; document: string }[] = [
    { name: 'a declaration missing ?>', document: '<?xml version="1.0"<svg/>' },
    { name: 'a declaration cut off at the end', document: '<?xml version="1.0"' },
    { name: 'a declaration with no version', document: '<?xml encoding="UTF-8"?><svg/>' },
    { name: 'a version with no equals sign', document: '<?xml version "1.0"?><svg/>' },
    { name: 'an unquoted version', document: '<?xml version=1.0?><svg/>' },
    { name: 'a version that is not 1.x', document: '<?xml version="2.0"?><svg/>' },
    { name: 'a version with no minor digits', document: '<?xml version="1."?><svg/>' },
    { name: 'a version with a letter for its minor', document: '<?xml version="1.a"?><svg/>' },
    { name: 'mismatched quotes', document: '<?xml version="1.0\'?><svg/>' },
    {
      name: 'an encoding other than UTF-8',
      document: '<?xml version="1.0" encoding="ISO-8859-1"?><svg/>',
    },
    {
      name: 'the encoding spelled utf8',
      document: '<?xml version="1.0" encoding="utf8"?><svg/>',
    },
    {
      name: 'the encoding spelled with an underscore',
      document: '<?xml version="1.0" encoding="UTF_8"?><svg/>',
    },
    {
      name: 'standalone with no space before it',
      document: '<?xml version="1.0"standalone="no"?><svg/>',
    },
    {
      name: 'standalone outside yes and no',
      document: '<?xml version="1.0" standalone="YES"?><svg/>',
    },
    {
      name: 'standalone of another length',
      document: '<?xml version="1.0" standalone="maybe"?><svg/>',
    },
    {
      name: 'standalone before encoding',
      document: '<?xml version="1.0" standalone="no" encoding="UTF-8"?><svg/>',
    },
    {
      name: 'a pseudo-attribute with no space before it',
      document: '<?xml version="1.0"encoding="UTF-8"?><svg/>',
    },
    { name: 'an unknown pseudo-attribute', document: '<?xml version="1.0" foo="bar"?><svg/>' },
    { name: 'an unterminated comment', document: '<!-- never closed <svg/>' },
    { name: 'a comment ending in --->', document: '<!-- a ---><svg/>' },
    { name: 'a double hyphen inside a comment', document: '<!-- a -- b --><svg/>' },
    { name: 'a comment whose body is one hyphen', document: '<!---><svg/>' },
  ]
  for (const { name, document } of malformed) {
    it(`rejects ${name}`, () => {
      expect(check(document)).toBe('prolog')
    })
  }

  const notRoot: { name: string; document: string | number[] }[] = [
    { name: 'a DOCTYPE', document: '<!DOCTYPE svg><svg/>' },
    { name: 'a lower-case doctype', document: '<!doctype svg><svg/>' },
    {
      name: 'a DOCTYPE after a declaration',
      document: '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    },
    { name: 'a CDATA section before the root', document: '<![CDATA[x]]><svg/>' },
    {
      name: 'an xml-stylesheet processing instruction',
      document: '<?xml-stylesheet href="https://example.com/x"?><not-svg><svg/></not-svg>',
    },
    { name: 'any other processing instruction', document: '<?php x ?><svg/>' },
    {
      name: 'a comment hiding a root before another element',
      document: '<!-- <svg/> --><not-svg/>',
    },
    { name: 'whitespace before the declaration', document: ' <?xml version="1.0"?><svg/>' },
    {
      name: 'a second declaration',
      document: '<?xml version="1.0"?><?xml version="1.0"?><svg/>',
    },
    {
      name: 'a declaration after a byte order mark and a space',
      document: [...BOM, 0x20, ...utf8('<?xml version="1.0"?><svg/>')],
    },
    { name: 'text before the root', document: 'hello <svg/>' },
    { name: 'a form feed, which is not XML whitespace', document: '\f<svg/>' },
    { name: 'a no-break space, which is not XML whitespace', document: ' <svg/>' },
    { name: 'another element', document: '<html><svg/></html>' },
    { name: 'a longer name', document: '<svgx/>' },
    { name: 'an upper-case root', document: '<SVG>' },
    { name: 'a root with one letter in upper case', document: '<svG>' },
    { name: 'a root one letter off', document: '<svh/>' },
    { name: 'a prefixed root', document: '<svg:svg xmlns:svg="x"/>' },
    { name: 'a slash not followed by >', document: '<svg/ >' },
    { name: 'a root cut off after the name', document: '<svg' },
    { name: 'a root cut off after the slash', document: '<svg/' },
    { name: 'a document that is only a byte order mark', document: BOM },
    { name: 'a document of only whitespace', document: ' \n' },
    { name: 'a bare declaration', document: '<?xml version="1.0"?>' },
  ]
  for (const { name, document } of notRoot) {
    it(`rejects ${name}`, () => {
      expect(check(document)).toBe('root')
    })
  }
})

/**
 * An independent oracle over the bytes read as Latin-1: the prolog and root as one regular
 * expression, UTF-8 by Node's fatal decoder, plus the NUL rule.
 */
const S = '[ \\t\\r\\n]'
const QUOTED = (body: string): string => `(?:"${body}"|'${body}')`
const DECLARATION =
  `<\\?xml${S}+version${S}*=${S}*${QUOTED('1\\.[0-9]+')}` +
  `(?:${S}+encoding${S}*=${S}*${QUOTED('[uU][tT][fF]-8')})?` +
  `(?:${S}+standalone${S}*=${S}*${QUOTED('(?:yes|no)')})?${S}*\\?>`
const ORACLE = new RegExp(
  `^(?:\\xEF\\xBB\\xBF)?(?:${DECLARATION})?(?:${S}|<!--(?:[^-]|-[^-])*-->)*<svg(?:${S}|>|/>)`,
)
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function oracleAccepts(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    DECODER.decode(bytes)
  } catch {
    return false
  }
  return ORACLE.test(Buffer.from(bytes).toString('latin1'))
}

describe('properties', () => {
  it('never throws on random bytes and accepts exactly what the oracle accepts', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const problem = svgDocumentProblem(b64(bytes))
        expect(problem === null).toBe(bytes.length > 0 && oracleAccepts(bytes))
      }),
      { numRuns: 2000 },
    )
  })

  it('agrees with the oracle on documents built from prolog fragments', () => {
    const fragment = fc.constantFrom(
      '﻿',
      '<?xml',
      ' version="1.0"',
      " version='1.1'",
      ' encoding="UTF-8"',
      " encoding='utf-8'",
      ' encoding="latin1"',
      ' standalone="yes"',
      '?>',
      ' ',
      '\n',
      '\t',
      '<!--',
      '-->',
      '--',
      '-',
      'x',
      '<!DOCTYPE svg>',
      '<?pi?>',
      '<svg',
      '<svg>',
      '<svg/>',
      '/>',
      '<svgx',
      '<SVG',
      '\u0000',
      'é',
    )
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 10 }), (parts) => {
        const bytes = new Uint8Array(Buffer.from(parts.join(''), 'utf8'))
        const problem = svgDocumentProblem(b64(bytes))
        expect(problem === null).toBe(bytes.length > 0 && oracleAccepts(bytes))
      }),
      { numRuns: 5000 },
    )
  })

  it('starts every accepted document, after its prolog, with the exact root', () => {
    const prolog = fc.constantFrom(
      '',
      '﻿',
      '<?xml version="1.0"?>',
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n',
      '<!-- c -->',
      ' \t\r\n',
    )
    const body = fc.string({ maxLength: 40 })
    fc.assert(
      fc.property(
        prolog,
        fc.constantFrom('<svg/>', '<svg>', '<svg '),
        body,
        (p, root, rest) => {
          const document = `${p}${root}${rest}`
          const accepted = check(document) === null
          // Buffer encodes any string as valid UTF-8, so only a NUL can fail it.
          expect(accepted).toBe(!rest.includes('\u0000'))
          if (accepted) expect(document.slice(p.length).startsWith('<svg')).toBe(true)
        },
      ),
    )
  })
})
