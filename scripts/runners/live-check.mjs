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
 * The JSON call is asked for in a prompt on the adapters that have no other way of asking, so
 * what comes back is a model's idea of "only this object": it may arrive in a code fence or
 * with a sentence around it. That is tolerated — the object is taken out of the fence, or the
 * first balanced `{…}` is read out of the text — because the claim under check is that the
 * adapter delivers usable JSON-shaped output, not that a model can follow an instruction about
 * whitespace. An empty object is not tolerated: it parses, and it proves nothing.
 *
 * Usage: node live-check.mjs <provider> <model> [--release]
 * With `--release` the package is required to come from the project this runner sits in.
 * Exit codes: 0 both calls were as documented, 1 one was not, 2 wrong usage.
 *
 * @module
 */

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

/**
 * The first balanced `{…}` in a string, or `null` when there is none.
 *
 * Braces inside string literals are skipped, so a value like `"}"` does not close the object
 * early. This reads one object out of surrounding prose; it is not a JSON parser, and what it
 * finds is handed to `JSON.parse` to be judged.
 */
function firstBracedSpan(text) {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/** The output as it might have been meant, most literal reading first. */
function jsonCandidates(text) {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /```[A-Za-z]*\n([\s\S]*?)```/.exec(trimmed)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const braced = firstBracedSpan(trimmed)
  if (braced !== null) candidates.push(braced)
  return candidates
}

/**
 * The JSON call additionally has to produce a non-empty JSON object at the top level.
 *
 * Exported so the tolerance above can be held to examples in a test. Nothing else in this file
 * is: the rest needs a provider, which is the point of the file.
 */
export function checkJsonShape(text, problems) {
  let firstParsed
  for (const candidate of jsonCandidates(text)) {
    let value
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (firstParsed === undefined) firstParsed = { value }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    // An object that parses and says nothing is what comes back when a provider has given up
    // on the request; accepting it would leave this check unable to fail.
    if (Object.keys(value).length === 0) {
      problems.push('the JSON call: the output was an empty object, which proves nothing')
    }
    return
  }
  problems.push(
    firstParsed === undefined
      ? 'the JSON call: the output did not parse as JSON, in a code fence or otherwise'
      : 'the JSON call: the output parsed, but not to a JSON object',
  )
}

/**
 * Cancels the call in flight and stops when this process is asked to stop.
 *
 * The message names the signal and nothing else — the same rule as everywhere else in this
 * file, since a shutdown path is no place to start printing what a request contained.
 */
function abortOnSignal(controller) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`the live check was stopped by ${signal}\n`)
      controller.abort()
      // A handler replaces the default disposition, so the exit has to be explicit; a stopped
      // check verified nothing, which is a failure.
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
  const llmswitch = await import('llmswitch')
  const { ProviderError } = llmswitch

  const keyName = KEYS[provider]
  const apiKey = process.env[keyName] ?? ''
  const redact = redactor(apiKey)
  if (apiKey === '') {
    process.stderr.write(`${keyName} is not set in this process\n`)
    return 1
  }

  const build = {
    anthropic: () => llmswitch.anthropic({ apiKey: () => Promise.resolve(apiKey) }),
    gemini: () => llmswitch.gemini({ apiKey: () => Promise.resolve(apiKey) }),
    'openai-compatible': () => {
      const options = { apiKey: () => Promise.resolve(apiKey) }
      // In release mode the parent refuses to pass an override at all, so this is the
      // adapter's own default endpoint; locally an override may travel and is honoured.
      const baseUrl = process.env.OPENAI_BASE_URL ?? ''
      if (!release && baseUrl !== '') options.baseUrl = baseUrl
      return llmswitch.openaiCompatible(options)
    },
  }
  const prepared = await build[provider]().prepare()

  const problems = []
  // One controller for the whole run, so an interrupt reaches the call in flight rather than
  // leaving a provider answering a request nobody is waiting for any more.
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

// Only when this file is what was run. A test that imports it to check one pure function must
// not thereby start calling a provider.
if (process.argv[1] === import.meta.filename) {
  try {
    process.exitCode = await main()
  } catch (error) {
    // The catch-all path has no adapter to ask, so it says only what kind of failure it was.
    process.stderr.write(
      `the live check could not run: ${error instanceof Error ? error.name : 'unknown failure'}\n`,
    )
    process.exitCode = 1
  }
}
