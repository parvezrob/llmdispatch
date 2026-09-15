/**
 * Shared HTTP helpers for the built-in adapters: one fetch per attempt, status-family
 * defaults, and abort vs network rejection split (spec §5c).
 *
 * @module
 */

import { ProviderError } from '../errors'
import type { ProviderErrorKind, TokenUsage } from '../types'

/** What a successful HTTP exchange hands back before provider-specific parsing. */
export interface HttpResult {
  status: number
  body: unknown
}

/**
 * One request. Always uses `redirect: 'error'`. Rejects with `ProviderError('aborted')`
 * when the signal fired; other fetch failures, including a body that never arrives, are
 * `transient`. JSON parse failures stay a null body, not a network error.
 */
export async function fetchJson(
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
): Promise<HttpResult> {
  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: 'error',
    })
    // Body settlement is still network I/O. A reset here must classify like the fetch
    // rejection above; otherwise a raw TypeError escapes and the core treats it as
    // `provider_unclassified` (no fallback). JSON.parse stays outside this catch.
    text = await response.text()
  } catch {
    if (init.signal.aborted) {
      throw new ProviderError('aborted', { message: 'request aborted' })
    }
    throw new ProviderError('transient', { message: 'network failure' })
  }

  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = null
    }
  }
  return { status: response.status, body }
}

/**
 * Universal status-family default (spec §5c): total by construction for unmapped codes.
 * Callers override before this for provider-specific rows.
 */
export function classifyByStatusFamily(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || status === 429) return 'rate_limit'
  if (status === 404) return 'model_not_found'
  if (status === 408) return 'transient'
  if (status >= 400 && status < 500) return 'invalid_request'
  if (status >= 500) return 'transient'
  return 'transient'
}

/** Throws a classified `ProviderError` for an HTTP error status. */
export function throwForStatus(status: number, kind?: ProviderErrorKind): never {
  throw new ProviderError(kind ?? classifyByStatusFamily(status), { status })
}

/** Non-negative safe integers only; otherwise `null`. */
export function asTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Builds usage from required base counters. Missing or invalid → `null`. Additive optional
 * fields default to 0 when absent; present-but-invalid forces `null`.
 */
export function buildUsage(
  inputBase: unknown,
  outputBase: unknown,
  additiveInput: unknown[] = [],
  additiveOutput: unknown[] = [],
): TokenUsage | null {
  const input = asTokenCount(inputBase)
  const output = asTokenCount(outputBase)
  if (input === null || output === null) return null

  let inputExtra = 0
  for (const part of additiveInput) {
    if (part === undefined || part === null) continue
    const n = asTokenCount(part)
    if (n === null) return null
    inputExtra += n
  }

  let outputExtra = 0
  for (const part of additiveOutput) {
    if (part === undefined || part === null) continue
    const n = asTokenCount(part)
    if (n === null) return null
    outputExtra += n
  }

  const inputTokens = input + inputExtra
  const outputTokens = output + outputExtra
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null
  return { inputTokens, outputTokens }
}

/** Plain object check for wire envelopes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The raster types a generated image may come back as (spec §6). */
export const GENERATED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

/**
 * The adapters' copy of the §3 point 4b count cap, read on the wire side before an adapter
 * scans a generated image. The core states both caps in `core/image-output.ts`, which a
 * provider may not import (`.dependency-cruiser.cjs`); a unit test holds the two pairs
 * together.
 */
export const MAX_GENERATED_IMAGES = 32

/**
 * The per-image ceiling in base64 characters that goes with `MAX_GENERATED_IMAGES`. Reading
 * the length first is what keeps an oversized payload from costing a full grammar scan.
 */
export const MAX_GENERATED_IMAGE_CHARACTERS = 30_000_000

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+$/
const TRAILING_PADDING = /={1,2}$/

/**
 * Whether generated image data is base64 under the §6 grammar: non-empty, standard
 * alphabet, a multiple of four characters, `=` only as one or two trailing characters.
 * Stripping the padding first is what bounds it to the trailing position; the alphabet then
 * rejects whitespace and a data-URL prefix along with everything else outside it.
 *
 * This is the adapters' copy of the grammar. It lives here because a provider may not import
 * `core/parts.ts`, where the request side states the same rule (`.dependency-cruiser.cjs`).
 * A unit test holds this copy to `base64Problem`, so those two cannot drift apart unnoticed.
 * The conformance suite keeps a third copy, out of reach of both for the same boundary
 * reason and not covered by that test.
 */
export function isWireBase64(data: unknown): data is string {
  if (typeof data !== 'string' || data === '' || data.length % 4 !== 0) return false
  return BASE64_ALPHABET.test(data.replace(TRAILING_PADDING, ''))
}
