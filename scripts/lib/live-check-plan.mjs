/**
 * What the live check runs, and the loop that decides which checks start and with which
 * credential.
 *
 * Kept apart from `live-check-providers.mjs` so the decision can be tested without spawning
 * anything: `runChecks` is handed the environment and a `start` function, and a test can see
 * exactly which children would start and which names each one would receive. The tables
 * below are the only place a model is named.
 *
 * @module
 */

import { join } from 'node:path'

import { readProbes } from '../runners/image-probes.mjs'

const RUNNERS = join(import.meta.dirname, '..', 'runners')
export const RUNNER = join(RUNNERS, 'live-check.mjs')
export const IMAGE_RUNNER = join(RUNNERS, 'live-check-images.mjs')
/** The runners import these, so they are copied into the scratch project beside them. */
export const TOLERANCE = join(RUNNERS, 'json-tolerance.mjs')
export const IMAGE_PROBES = join(RUNNERS, 'image-probes.mjs')

/** The one adapter whose endpoint may be pointed elsewhere, and the name that does it. */
export const ENDPOINT_OVERRIDE = { provider: 'openai-compatible', name: 'OPENAI_BASE_URL' }

/**
 * The text adapters, each with the credential it needs and the model it is checked on.
 *
 * The models are the smallest each provider offers that handle every checked modality,
 * and the runner asks for a handful of tokens: these calls should cost a fraction of a
 * cent. Change them here when a provider retires one: nowhere else names a model.
 * For OpenAI that is not a small model at all: gpt-4.1-nano and gpt-4.1-mini silently
 * drop image parts (verified against the raw endpoint: the request carries the image,
 * the reported prompt tokens show it never reached the model), and gpt-4o-mini reads
 * images but fails the document check. gpt-4.1 is the smallest that passes all four.
 */
const PROVIDERS = [
  { name: 'anthropic', key: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
  { name: 'openai-compatible', key: 'OPENAI_API_KEY', model: 'gpt-4.1' },
  { name: 'gemini', key: 'GEMINI_API_KEY', model: 'gemini-3.5-flash-lite' },
]

/**
 * The image adapters, each with the credential it needs and the probes it runs: the model,
 * the operation's knobs, any factory options, and what the answer is expected to show
 * (`../runners/image-probes.mjs` says what each expectation checks). The models are the
 * cheapest that answer the question each probe asks; on OpenRouter every knob sent is one the
 * model's catalogue entry lists (read 2026-11-04). Change them here when a provider retires
 * one: nowhere else names a model.
 *
 * The Gemini probe asks for two images in one call. Whether `candidateCount` applies to image
 * models is not documented, so the answer is reported as a finding: two images, fewer, or the
 * provider's 400 (`invalid_request`). After a 400 one image is asked for, and only that answer
 * says whether the 400 was about the count. The OpenAI probes pin `quality: 'low'`, the
 * cheapest tier, so the run's cost is known in advance. The OpenRouter SVG probe is the one
 * that shows whether a vector model's documents pass the core's SVG document check.
 */
const IMAGE_PROVIDERS = [
  {
    name: 'gemini',
    key: 'GEMINI_API_KEY',
    probes: [
      {
        label: 'two 1K images',
        model: 'gemini-3.1-flash-lite-image',
        format: 'image',
        image: { count: 2, size: '1K' },
        expect: { usage: true, countProbe: true },
      },
    ],
  },
  {
    name: 'openai-images',
    key: 'OPENAI_API_KEY',
    // The same name the OpenAI-compatible check reads, and that check's endpoint may be
    // overridden: a key meant for another host must never reach api.openai.com.
    officialEndpointOnly: true,
    probes: [
      {
        label: 'two transparent 1K images',
        model: 'gpt-image-1-mini',
        format: 'image',
        image: { count: 2, aspectRatio: '1:1', size: '1K', background: 'transparent' },
        adapterOptions: { quality: 'low' },
        expect: { mediaType: 'image/png', alpha: true, pixels: '1024x1024', usage: true },
      },
      // gpt-image-2 rejects a transparent background with a 400 (seen 2026-11-04), so this
      // probe leaves the background unset and the alpha question to the older model above.
      {
        label: 'one 2K image',
        model: 'gpt-image-2',
        format: 'image',
        image: { aspectRatio: '1:1', size: '2K' },
        adapterOptions: { quality: 'low' },
        expect: { mediaType: 'image/png', pixels: '2048x2048', usage: true },
      },
    ],
  },
  {
    name: 'openrouter-images',
    key: 'OPENROUTER_API_KEY',
    probes: [
      {
        label: 'one 1K image',
        model: 'bytedance-seed/seedream-5-0-flash',
        format: 'image',
        image: { size: '1K' },
        expect: { reportedCost: true },
      },
      {
        label: 'one SVG document',
        model: 'recraft/recraft-v4-vector',
        format: 'svg',
        expect: { reportedCost: true },
      },
    ],
  },
]

/** Four calls to a live provider, two of them carrying a file; beyond this it is a hang. */
const CHECK_DEADLINE = 4 * 60_000
/** One image attempt may take its whole three-minute timeout. */
const IMAGE_ATTEMPT_DEADLINE = 3 * 60_000

/** How many attempts a probe table may make: a count probe may ask a second time. */
function attemptsOf(probes) {
  return probes.reduce((sum, probe) => sum + (probe.expect?.countProbe === true ? 2 : 1), 0)
}

/**
 * Every child the run starts, in order: the text checks, then the image probes. `args` are the
 * runner's arguments and carry no secret; `key` is the one credential the child receives.
 */
export const CHECKS = [
  ...PROVIDERS.map((descriptor) => ({
    name: descriptor.name,
    key: descriptor.key,
    runner: RUNNER,
    args: [descriptor.name, descriptor.model],
    timeout: CHECK_DEADLINE,
    endpointOverride: descriptor.name === ENDPOINT_OVERRIDE.provider,
    officialEndpointOnly: false,
  })),
  ...IMAGE_PROVIDERS.map((descriptor) => ({
    name: `${descriptor.name} (image probes)`,
    key: descriptor.key,
    runner: IMAGE_RUNNER,
    args: [descriptor.name, JSON.stringify(descriptor.probes)],
    // One deadline per possible attempt, and one more for starting up and reporting.
    timeout: (attemptsOf(descriptor.probes) + 1) * IMAGE_ATTEMPT_DEADLINE,
    endpointOverride: false,
    officialEndpointOnly: descriptor.officialEndpointOnly === true,
  })),
]

/** Problems with the image probe table, found before any child starts or any money is spent. */
export function probeTableProblems() {
  const problems = []
  for (const descriptor of IMAGE_PROVIDERS) {
    const found = []
    readProbes(JSON.stringify(descriptor.probes), found)
    for (const problem of found) problems.push(`${descriptor.name} (image probes): ${problem}`)
  }
  return problems
}

/**
 * The environment names one check's child is given: exactly one credential, and the endpoint
 * override only for the check that can use it.
 */
export function childValues(check, env) {
  const values = { [check.key]: env[check.key] }
  if (check.endpointOverride) values[ENDPOINT_OVERRIDE.name] = env[ENDPOINT_OVERRIDE.name]
  return values
}

/** The values put in a check's child environment that must not appear in its output. */
export function secretsFor(check, env) {
  return [env[check.key] ?? ''].filter((value) => value !== '')
}

/**
 * Starts each check that may run, one at a time, and collects what went wrong.
 *
 * A check is skipped when its key is absent, and also, for a check that may only call its
 * provider's official endpoint, when `OPENAI_BASE_URL` is set: the key under that name then
 * belongs to the overridden endpoint. In release mode a skip is a problem instead (the parent
 * refuses an override before it gets here).
 *
 * @param opts `checks` is what to run; `env` is where keys and the override are read from;
 *   `release` says whether a skip is a failure; `start(check, values)` starts one child with
 *   exactly those environment names and resolves to `{ ok, note }`; `write` takes one line.
 * @returns How many checks ran, and the problems found.
 */
export async function runChecks(opts) {
  const { checks, env, release, start, write } = opts
  const problems = []
  let ran = 0
  for (const check of checks) {
    if ((env[check.key] ?? '') === '') {
      if (release) problems.push(`${check.name}: ${check.key} is not set`)
      else write(`${check.name}: skipped, ${check.key} is not set`)
      continue
    }
    if (check.officialEndpointOnly && (env[ENDPOINT_OVERRIDE.name] ?? '') !== '') {
      const notice =
        `${check.name}: skipped, ${ENDPOINT_OVERRIDE.name} is set, so ${check.key} belongs to ` +
        'that endpoint and is not sent to the official one'
      if (release) problems.push(notice)
      else write(notice)
      continue
    }

    ran += 1
    const outcome = await start(check, childValues(check, env))
    if (outcome.note !== '') write(`${check.name}: ${outcome.note}`, 'stderr')
    if (!outcome.ok) problems.push(`${check.name}: the check failed`)
  }
  return { ran, problems }
}
