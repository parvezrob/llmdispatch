#!/usr/bin/env node
/**
 * One provider's live check, in a process that holds one provider's credential.
 *
 * Four calls: a plain one, one asking for a JSON object, one sending an image and one sending
 * a PDF. All have to come back complete, with text, and with usage the package was able to
 * normalize: a provider whose wire shape has moved under the adapter shows up here as a null
 * usage or a missing field, which is the whole reason this check exists. The two media calls
 * also have to answer what their fixture put in front of the model, so an adapter that sent a
 * well-formed body the model never actually read cannot pass them.
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
 * Exit codes: 0 every call was as documented, 1 one was not, 2 wrong usage.
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
/** The prompts, kept to a sentence each for the same reason. */
const PLAIN_PROMPT = 'Reply with the single word: ready'
const JSON_PROMPT = 'Reply with only this JSON object and nothing else: {"ok": true}'
const IMAGE_PROMPT = 'Reply with the single word naming the colour of this image.'
const DOCUMENT_PROMPT = 'Reply with the text of the attached document and nothing else.'

/**
 * The media fixtures and the answer each one admits.
 *
 * A 64x64 image of one colour and a one-page PDF carrying one invented word: a model that was
 * handed either can say what is in it, and a model that was handed a well-formed request the
 * provider never decoded cannot.
 */
const IMAGE_FIXTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'
const IMAGE_ANSWER = 'red'
const DOCUMENT_FIXTURE =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoQ0lOTkFCQVJIRVJPTikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDUKJSVFT0YK'
const DOCUMENT_ANSWER = 'CINNABARHERON'

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
 * Whether a media call's answer carries what its fixture put in front of the model.
 *
 * Matched on word boundaries, not as a substring: 'red' sits inside 'rendered' and 'coloured',
 * so a substring test passes answers that never name the colour at all.
 *
 * The expected word is never printed: it is part of a prompt, and this runner quotes neither
 * prompts nor answers.
 */
function checkAnswer(label, response, expected, problems) {
  if (response.kind !== 'complete') return
  if (!new RegExp(`\\b${expected}\\b`, 'i').test(response.text)) {
    problems.push(`${label}: the answer did not carry what the fixture put in the request`)
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
  const request = (parts, responseFormat) => ({
    parts,
    model,
    responseFormat,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    signal: inFlight.signal,
  })
  const text = (prompt) => [{ type: 'text', text: prompt }]

  try {
    const plain = await prepared.complete(request(text(PLAIN_PROMPT), { type: 'text' }))
    checkResponse('the plain call', plain, problems)
  } catch (error) {
    problems.push(`the plain call: ${describeFailure(error, ProviderError)}`)
  }

  try {
    const json = await prepared.complete(
      request(text(JSON_PROMPT), { type: 'json', topLevel: 'object' }),
    )
    checkResponse('the JSON call', json, problems)
    if (json.kind === 'complete') checkJsonShape(json.text, problems)
  } catch (error) {
    problems.push(`the JSON call: ${describeFailure(error, ProviderError)}`)
  }

  try {
    const image = await prepared.complete(
      request(
        [...text(IMAGE_PROMPT), { type: 'file', mediaType: 'image/png', data: IMAGE_FIXTURE }],
        { type: 'text' },
      ),
    )
    checkResponse('the image call', image, problems)
    checkAnswer('the image call', image, IMAGE_ANSWER, problems)
  } catch (error) {
    problems.push(`the image call: ${describeFailure(error, ProviderError)}`)
  }

  // Sent to every adapter: all three map PDFs, so a model that will not take one is a result
  // this check reports rather than something it routes around.
  try {
    const document = await prepared.complete(
      request(
        [
          ...text(DOCUMENT_PROMPT),
          {
            type: 'file',
            mediaType: 'application/pdf',
            data: DOCUMENT_FIXTURE,
            filename: 'live-check.pdf',
          },
        ],
        { type: 'text' },
      ),
    )
    checkResponse('the document call', document, problems)
    checkAnswer('the document call', document, DOCUMENT_ANSWER, problems)
  } catch (error) {
    problems.push(`the document call: ${describeFailure(error, ProviderError)}`)
  }

  for (const problem of problems) process.stdout.write(redact(`${problem}\n`))
  if (problems.length === 0) {
    process.stdout.write(`${provider}: all four calls completed with normalized usage\n`)
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
