#!/usr/bin/env node
/**
 * One provider's live check, in a process that holds one provider's credential.
 *
 * Two calls: a plain one and one asking for a JSON object. Both have to come back complete,
 * with text, and with usage the package was able to normalize — a provider whose wire shape
 * has moved under the adapter shows up here as a null usage or a missing field, which is the
 * whole reason this check exists.
 *
 * Nothing it prints carries a credential, a prompt, a request or a response body. The key is
 * read from the environment, never from an argument, and every line goes out through a
 * redactor, so a value that reached a message by some path nobody thought of still does not
 * reach the terminal.
 *
 * How much untidiness is tolerated in a prompted JSON answer is decided by
 * `./json-tolerance.mjs`, which is copied into the scratch project alongside this file.
 *
 * Usage: node live-check.mjs <provider> <model> [--release]
 * With `--release` the package is required to come from the project this runner sits in.
 * Exit codes: 0 both calls were as documented, 1 one was not, 2 wrong usage.
 *
 * @module
 */

import { checkJsonShape } from './json-tolerance.mjs'

/** Which environment name each adapter's credential arrives under. */
const KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
}

/** Small enough that a run costs almost nothing, large enough for a one-line answer. */
const MAX_OUTPUT_TOKENS = 64
/** The two prompts, kept to a sentence each for the same reason. */
const PLAIN_PROMPT = 'Reply with the single word: ready'
const JSON_PROMPT = 'Reply with only this JSON object and nothing else: {"ok": true}'

/** A credential can only be printed if it is in the string; this makes sure it is not. */
function redactor(secret) {
  return (text) => (secret === '' ? text : text.split(secret).join('<redacted>'))
}

/**
 * A failure in terms of what it was, never what it said.
 *
 * A `ProviderError` is safe to name: the package builds it without prompt, output, or
 * anything the provider sent back. Nothing else is, so nothing else is quoted.
 */
function describeFailure(error, ProviderError) {
  if (ProviderError.is(error)) return `ProviderError(${error.kind})`
  if (error instanceof Error) return `${error.name} (message withheld)`
  return `a thrown ${typeof error}`
}

/** Everything a completed call has to be, whichever adapter produced it. */
function checkResponse(label, response, problems) {
  if (response.kind !== 'complete') {
    problems.push(`${label}: kind was '${response.kind}', not 'complete'`)
    return
  }
  if (typeof response.text !== 'string' || response.text.trim() === '') {
    problems.push(`${label}: the output text was empty`)
  }
  const { usage } = response
  if (usage === null) {
    problems.push(`${label}: usage was null, so the adapter could not read the counters`)
    return
  }
  for (const field of ['inputTokens', 'outputTokens']) {
    const value = usage[field]
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(`${label}: ${field} was not a non-negative whole number`)
    }
  }
}

/** Cancels the call in flight when this process is asked to stop. */
function abortOnSignal(controller) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`the live check was stopped by ${signal}\n`)
      controller.abort()
      // A handler replaces the default disposition, so the exit must be explicit.
      process.exit(1)
    })
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const release = argv.includes('--release')
  const [provider, model] = argv.filter((argument) => argument !== '--release')
  if (provider === undefined || model === undefined || !Object.hasOwn(KEYS, provider)) {
    process.stderr.write('usage: live-check.mjs <provider> <model> [--release]\n')
    return 2
  }

  if (release) {
    const { assertInstalledPackageResolves } = await import('./subpath-resolution.mjs')
    try {
      for (const { subpath, file } of assertInstalledPackageResolves()) {
        process.stdout.write(`resolved ${subpath} -> ${file}\n`)
      }
    } catch (error) {
      // Said in full: the guard reports file paths and nothing else, and a run that imported
      // the wrong package is worth naming precisely.
      process.stderr.write(`${error instanceof Error ? error.message : 'unknown failure'}\n`)
      return 1
    }
  }
  const llmdispatch = await import('llmdispatch')
  const { ProviderError } = llmdispatch

  const keyName = KEYS[provider]
  const apiKey = process.env[keyName] ?? ''
  const redact = redactor(apiKey)
  if (apiKey === '') {
    process.stderr.write(`${keyName} is not set in this process\n`)
    return 1
  }

  const build = {
    anthropic: () => llmdispatch.anthropic({ apiKey: () => Promise.resolve(apiKey) }),
    gemini: () => llmdispatch.gemini({ apiKey: () => Promise.resolve(apiKey) }),
    'openai-compatible': () => {
      const options = { apiKey: () => Promise.resolve(apiKey) }
      // In release mode the parent refuses to pass an override at all, so this is the
      // adapter's own default endpoint; locally an override may travel and is honoured.
      const baseUrl = process.env.OPENAI_BASE_URL ?? ''
      if (!release && baseUrl !== '') options.baseUrl = baseUrl
      return llmdispatch.openaiCompatible(options)
    },
  }
  const prepared = await build[provider]().prepare()

  const problems = []
  // One controller for the whole run, so an interrupt reaches the call in flight.
  const inFlight = new AbortController()
  abortOnSignal(inFlight)
  const request = (prompt, responseFormat) => ({
    prompt,
    model,
    responseFormat,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    signal: inFlight.signal,
  })

  try {
    const plain = await prepared.complete(request(PLAIN_PROMPT, { type: 'text' }))
    checkResponse('the plain call', plain, problems)
  } catch (error) {
    problems.push(`the plain call: ${describeFailure(error, ProviderError)}`)
  }

  try {
    const json = await prepared.complete(
      request(JSON_PROMPT, { type: 'json', topLevel: 'object' }),
    )
    checkResponse('the JSON call', json, problems)
    if (json.kind === 'complete') checkJsonShape(json.text, problems)
  } catch (error) {
    problems.push(`the JSON call: ${describeFailure(error, ProviderError)}`)
  }

  for (const problem of problems) process.stdout.write(redact(`${problem}\n`))
  if (problems.length === 0) {
    process.stdout.write(`${provider}: both calls completed with normalized usage\n`)
  }
  return problems.length === 0 ? 0 : 1
}

// Never gate this on an entry-point check: `import.meta.filename` is realpath-resolved and
// `process.argv[1]` is not, so under a symlinked TMPDIR the runner would silently do nothing.
try {
  process.exitCode = await main()
} catch (error) {
  // No adapter to ask here, so only the kind of failure is reported.
  process.stderr.write(
    `the live check could not run: ${error instanceof Error ? error.name : 'unknown failure'}\n`,
  )
  process.exitCode = 1
}
