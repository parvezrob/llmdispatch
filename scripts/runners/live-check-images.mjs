#!/usr/bin/env node
/**
 * One image adapter's live probes, in a process that holds that provider's credential only.
 *
 * Each probe is a `run()` of an image or SVG operation against a real model; what each one
 * asserts is in `./image-probes.mjs`, which is copied into the scratch project alongside this
 * file. The probe table, models included, comes from `live-check-providers.mjs` as one JSON
 * argument: it names models and knobs and nothing secret.
 *
 * The key is read from the environment, never from an argument, and every line goes out
 * through a redactor. A line starting `finding:` is something the run learned about a
 * provider. Some stand alone, such as whether a model takes a candidate count; others explain
 * a failure the run also reports, such as why the core refused a vector model's document.
 *
 * Usage: node live-check-images.mjs <adapter> <probes-json> [--release]
 * With `--release` the package is required to come from the project this runner sits in.
 * Exit codes: 0 every probe was as documented, 1 one was not, 2 wrong usage.
 *
 * @module
 */

import { IMAGE_ADAPTERS, readProbes, runProbes } from './image-probes.mjs'

/** Which environment name each image adapter's credential arrives under. */
const KEYS = {
  gemini: 'GEMINI_API_KEY',
  'openai-images': 'OPENAI_API_KEY',
  'openrouter-images': 'OPENROUTER_API_KEY',
}

/** A credential can only be printed if it is in the string; this makes sure it is not. */
function redactor(secret) {
  return (text) => (secret === '' ? text : text.split(secret).join('<redacted>'))
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
  const [adapter, table] = argv.filter((argument) => argument !== '--release')
  if (
    adapter === undefined ||
    table === undefined ||
    !IMAGE_ADAPTERS.includes(adapter) ||
    !Object.hasOwn(KEYS, adapter)
  ) {
    process.stderr.write('usage: live-check-images.mjs <adapter> <probes-json> [--release]\n')
    return 2
  }
  const tableProblems = []
  const probes = readProbes(table, tableProblems)
  if (probes === null) {
    for (const problem of tableProblems) process.stderr.write(`${problem}\n`)
    return 2
  }

  if (release) {
    const { assertInstalledPackageResolves } = await import('./subpath-resolution.mjs')
    try {
      for (const { subpath, file } of assertInstalledPackageResolves()) {
        process.stdout.write(`resolved ${subpath} -> ${file}\n`)
      }
    } catch (error) {
      // Said in full: the guard reports file paths and nothing else.
      process.stderr.write(`${error instanceof Error ? error.message : 'unknown failure'}\n`)
      return 1
    }
  }
  const llmdispatch = await import('llmdispatch')
  const { z } = await import('zod')

  const keyName = KEYS[adapter]
  const apiKey = process.env[keyName] ?? ''
  const redact = redactor(apiKey)
  if (apiKey === '') {
    process.stderr.write(`${keyName} is not set in this process\n`)
    return 1
  }

  const inFlight = new AbortController()
  abortOnSignal(inFlight)
  const problems = await runProbes({
    llmdispatch,
    z,
    adapter,
    apiKey,
    probes,
    signal: inFlight.signal,
    write: (line) => process.stdout.write(redact(`${line}\n`)),
  })

  for (const problem of problems) process.stdout.write(redact(`${problem}\n`))
  if (problems.length === 0) {
    process.stdout.write(`${adapter}: all ${String(probes.length)} image probe(s) passed\n`)
  }
  return problems.length === 0 ? 0 : 1
}

// Never gate this on an entry-point check: `import.meta.filename` is realpath-resolved and
// `process.argv[1]` is not, so under a symlinked TMPDIR the runner would silently do nothing.
try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `the live check could not run: ${error instanceof Error ? error.name : 'unknown failure'}\n`,
  )
  process.exitCode = 1
}
