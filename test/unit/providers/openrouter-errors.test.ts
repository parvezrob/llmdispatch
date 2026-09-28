/**
 * OpenRouter's error envelope (spec §5c), held directly: where the error is read from, the
 * precedence of the fields that name it, when a 2xx answer embeds one, and what each named
 * kind classifies as. The adapters' own tests prove each one routes through these functions.
 */

import { describe, expect, it } from 'vitest'

import {
  classifyEmbeddedError,
  isOpenRouterModeration,
  openRouterErrorType,
} from '../../../src/providers/openrouter-errors'

describe('openRouterErrorType: the fields that name the error', () => {
  it.each([
    [
      'metadata.error_type over every other field',
      {
        error: {
          metadata: { error_type: 'moderation', code: 'auth' },
          code: 'credit',
          type: 'server_error',
        },
      },
      'moderation',
    ],
    [
      'metadata.code when metadata.error_type is absent',
      { error: { metadata: { code: 'auth' }, code: 'credit', type: 'server_error' } },
      'auth',
    ],
    [
      'error.code when metadata names nothing',
      { error: { metadata: {}, code: 'credit', type: 'server_error' } },
      'credit',
    ],
    [
      'error.type when nothing else names it',
      { error: { type: 'server_error' } },
      'server_error',
    ],
    [
      'error.code when metadata is not a record',
      { error: { metadata: 'moderation', code: 'credit' } },
      'credit',
    ],
    [
      'metadata.code when metadata.error_type is not a string',
      { error: { metadata: { error_type: 1, code: 'auth' } } },
      'auth',
    ],
    [
      'error.type when error.code is not a string',
      { error: { code: 402, type: 'rate_limit' } },
      'rate_limit',
    ],
  ])('reads %s', (_label, body, expected) => {
    expect(openRouterErrorType(body)).toBe(expected)
  })

  it.each([
    ['a null body', null],
    ['a string body', 'moderation'],
    ['an array body', [{ error: { type: 'moderation' } }]],
    ['a body without an error', { data: [] }],
    ['an error that is not a record', { error: 'moderation' }],
    ['an error naming nothing', { error: { message: 'moderation' } }],
    ['an error whose fields are not strings', { error: { code: 1, type: null } }],
  ])('names nothing for %s', (_label, body) => {
    expect(openRouterErrorType(body)).toBeUndefined()
  })

  it("reads the first choice's error ahead of the top-level one", () => {
    const body = {
      error: { type: 'moderation' },
      choices: [{ error: { type: 'credit' } }],
    }
    expect(openRouterErrorType(body)).toBe('credit')
  })

  it('reads the top-level error when the first choice carries none', () => {
    const body = { error: { type: 'moderation' }, choices: [{ finish_reason: 'error' }] }
    expect(openRouterErrorType(body)).toBe('moderation')
  })

  it.each([
    ['the choices are empty', { error: { type: 'moderation' }, choices: [] }],
    ['the choices are not an array', { error: { type: 'moderation' }, choices: {} }],
    ['the first choice is not a record', { error: { type: 'moderation' }, choices: ['x'] }],
    [
      "the first choice's error is not a record",
      { error: { type: 'moderation' }, choices: [{ error: 'credit' }] },
    ],
  ])('falls back to the top-level error when %s', (_label, body) => {
    expect(openRouterErrorType(body)).toBe('moderation')
  })

  it('reads only the first choice', () => {
    const body = { choices: [{ finish_reason: 'error' }, { error: { type: 'credit' } }] }
    expect(openRouterErrorType(body)).toBeUndefined()
  })
})

describe('isOpenRouterModeration', () => {
  it.each([
    ['metadata.error_type', { error: { metadata: { error_type: 'moderation' } } }],
    ['metadata.code', { error: { metadata: { code: 'moderation' } } }],
    ['error.code', { error: { code: 'moderation' } }],
    ['error.type', { error: { type: 'moderation' } }],
    ["the first choice's error", { choices: [{ error: { type: 'moderation' } }] }],
  ])('recognises moderation named by %s', (_label, body) => {
    expect(isOpenRouterModeration(body)).toBe(true)
  })

  it.each([
    ['another word', { error: { type: 'auth' } }],
    ['a word it only resembles', { error: { type: 'Moderation' } }],
    [
      'a word outranked by metadata',
      { error: { metadata: { code: 'auth' }, type: 'moderation' } },
    ],
    ['no error', {}],
    ['a null body', null],
  ])('is false for %s', (_label, body) => {
    expect(isOpenRouterModeration(body)).toBe(false)
  })
})

describe('classifyEmbeddedError: when a 2xx answer embeds an error', () => {
  it.each([
    ['a top-level error object', { error: { type: 'server_error' } }],
    ['a choice-level error object', { choices: [{ error: { type: 'server_error' } }] }],
    ["finish_reason 'error' with no error object", { choices: [{ finish_reason: 'error' }] }],
    ['a top-level error beside data', { error: {}, data: [{ b64_json: 'AAAA' }] }],
  ])('finds one for %s', (_label, body) => {
    expect(classifyEmbeddedError(body)).toBe('transient')
  })

  it.each([
    ['an ordinary completion', { choices: [{ finish_reason: 'stop', message: {} }] }],
    ['an images answer', { data: [{ b64_json: 'AAAA' }], usage: { cost: 0.01 } }],
    ['an empty body', {}],
    ['an error that is not a record', { error: 'moderation' }],
    ['a null error', { error: null }],
    ['choices that are not an array', { choices: { finish_reason: 'error' } }],
    ['a first choice that is not a record', { choices: ['error'] }],
    [
      "finish_reason 'error' on a later choice only",
      { choices: [{ finish_reason: 'stop' }, { finish_reason: 'error' }] },
    ],
  ])('finds none for %s', (_label, body) => {
    expect(classifyEmbeddedError(body)).toBeNull()
  })
})

describe('classifyEmbeddedError: each named kind', () => {
  it.each([
    ['moderation', 'refused'],
    ['auth', 'auth'],
    ['authentication', 'auth'],
    ['credit', 'rate_limit'],
    ['rate_limit', 'rate_limit'],
    ['rate-limit', 'rate_limit'],
    ['server_error', 'transient'],
    ['overloaded', 'transient'],
    ['Moderation', 'transient'],
  ] as const)('%s -> %s', (word, expected) => {
    expect(classifyEmbeddedError({ error: { type: word } })).toBe(expected)
    expect(classifyEmbeddedError({ error: { metadata: { error_type: word } } })).toBe(expected)
    expect(classifyEmbeddedError({ choices: [{ error: { code: word } }] })).toBe(expected)
  })

  it('is transient when the embedded error names nothing', () => {
    expect(classifyEmbeddedError({ error: { message: 'failed' } })).toBe('transient')
    expect(classifyEmbeddedError({ choices: [{ finish_reason: 'error' }] })).toBe('transient')
  })

  it('classifies by the precedence of the naming fields', () => {
    const body = { error: { metadata: { error_type: 'credit' }, code: 'moderation' } }
    expect(classifyEmbeddedError(body)).toBe('rate_limit')
  })

  it('classifies a choice-level error ahead of the top-level one', () => {
    const body = { error: { type: 'moderation' }, choices: [{ error: { type: 'auth' } }] }
    expect(classifyEmbeddedError(body)).toBe('auth')
  })
})
