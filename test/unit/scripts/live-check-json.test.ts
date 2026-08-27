import { describe, expect, it } from 'vitest'

import { checkJsonShape } from '../../../scripts/runners/json-tolerance.mjs'

/** What the live check accepts as "the model returned a JSON object", and what it does not. */
function problemsFor(text: string): string[] {
  const problems: string[] = []
  checkJsonShape(text, problems)
  return problems
}

describe('the live check reading a JSON answer', () => {
  it('accepts the object on its own', () => {
    expect(problemsFor('{"ok": true}')).toEqual([])
    expect(problemsFor('  \n{"ok": true}\n  ')).toEqual([])
  })

  it('accepts an object a model wrapped in a code fence', () => {
    expect(problemsFor('```json\n{"ok": true}\n```')).toEqual([])
    expect(problemsFor('```\n{"ok": true}\n```')).toEqual([])
  })

  it('accepts an object a model wrapped in a sentence', () => {
    expect(problemsFor('Sure! Here it is: {"ok": true} — let me know.')).toEqual([])
  })

  it('is not fooled by a brace inside a string', () => {
    expect(problemsFor('note: {"closing": "}", "ok": true} done')).toEqual([])
  })

  it('rejects an empty object, which parses and proves nothing', () => {
    expect(problemsFor('{}')).toEqual([
      'the JSON call: the output was an empty object, which proves nothing',
    ])
    expect(problemsFor('```json\n{}\n```')).toEqual([
      'the JSON call: the output was an empty object, which proves nothing',
    ])
  })

  it('rejects output that is not an object at the top level', () => {
    expect(problemsFor('[1, 2, 3]')).toEqual([
      'the JSON call: the output parsed, but not to a JSON object',
    ])
    expect(problemsFor('"ok"')).toEqual([
      'the JSON call: the output parsed, but not to a JSON object',
    ])
  })

  it('judges valid JSON as itself rather than looking inside it', () => {
    expect(problemsFor('[{"ok":true}]')).toEqual([
      'the JSON call: the output parsed, but not to a JSON object',
    ])
    expect(problemsFor('{"nested": {"ok": true}}')).toEqual([])
  })

  it('rejects output with no JSON in it at all', () => {
    expect(problemsFor('I cannot help with that.')).toEqual([
      'the JSON call: the output did not parse as JSON, in a code fence or otherwise',
    ])
    expect(problemsFor('{not json at all}')).toEqual([
      'the JSON call: the output did not parse as JSON, in a code fence or otherwise',
    ])
  })
})
