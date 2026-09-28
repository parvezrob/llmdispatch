/**
 * The status rows both OpenAI adapters classify with (spec §5c), held directly: every row,
 * the precedence between a status row and a `model_not_found` body, and the statuses no row
 * names. The adapters' own tests prove each one routes through these rows.
 */

import { describe, expect, it } from 'vitest'

import { classifyOpenAIStatus } from '../../../src/providers/openai-errors'
import type { ProviderErrorKind } from '../../../src/types'

const MISSING_BY_CODE = { error: { code: 'model_not_found' } }
const MISSING_BY_TYPE = { error: { type: 'model_not_found' } }

describe('classifyOpenAIStatus: the status rows', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [402, 'rate_limit'],
    [404, 'model_not_found'],
    [408, 'transient'],
    [498, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
    [529, 'transient'],
    [599, 'transient'],
    [400, 'invalid_request'],
    [413, 'invalid_request'],
    [422, 'invalid_request'],
  ] as const)('%i -> %s', (status, expected: ProviderErrorKind) => {
    expect(classifyOpenAIStatus(status, {})).toBe(expected)
  })

  it.each([
    [405, 'invalid_request'],
    [409, 'invalid_request'],
    [418, 'invalid_request'],
    [451, 'invalid_request'],
    [499, 'invalid_request'],
  ] as const)('%i, named by no row, -> %s by its family', (status, expected) => {
    expect(classifyOpenAIStatus(status, {})).toBe(expected)
  })

  it.each([0, 100, 199, 204, 302, 399])('%i, outside 4xx and 5xx, -> transient', (status) => {
    expect(classifyOpenAIStatus(status, {})).toBe('transient')
  })

  it.each([600, 700, 999])('%i, above 5xx, -> transient', (status) => {
    expect(classifyOpenAIStatus(status, {})).toBe('transient')
  })
})

describe('classifyOpenAIStatus: a model_not_found body', () => {
  it.each([
    ['400 with the code', 400, MISSING_BY_CODE],
    ['400 with the type', 400, MISSING_BY_TYPE],
    ['413 with the code', 413, MISSING_BY_CODE],
    ['422 with the code', 422, MISSING_BY_CODE],
    ['418 with the code', 418, MISSING_BY_CODE],
    ['498 with the code', 498, MISSING_BY_CODE],
    ['408 with the code', 408, MISSING_BY_CODE],
  ])('reclassifies %s as model_not_found', (_label, status, body) => {
    expect(classifyOpenAIStatus(status, body)).toBe('model_not_found')
  })

  it.each([
    ['401', 401, 'auth'],
    ['403', 403, 'auth'],
    ['429', 429, 'rate_limit'],
    ['402', 402, 'rate_limit'],
    ['500', 500, 'transient'],
    ['503', 503, 'transient'],
    ['599', 599, 'transient'],
  ] as const)('leaves %s on its status row', (_label, status, expected) => {
    expect(classifyOpenAIStatus(status, MISSING_BY_CODE)).toBe(expected)
    expect(classifyOpenAIStatus(status, MISSING_BY_TYPE)).toBe(expected)
  })

  it.each([
    ['a null body', null],
    ['a string body', 'model_not_found'],
    ['an array body', [MISSING_BY_CODE]],
    ['an error that is not a record', { error: 'model_not_found' }],
    ['a message only', { error: { message: 'model not found' } }],
    ['another code', { error: { code: 'invalid_value' } }],
    ['the code at the top level', { code: 'model_not_found' }],
  ])('keeps 400 invalid_request for %s', (_label, body) => {
    expect(classifyOpenAIStatus(400, body)).toBe('invalid_request')
  })
})
