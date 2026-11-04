/**
 * Which live-check children start, and which environment names each one is handed. Nothing
 * is spawned: `runChecks` gets a `start` that records its arguments, so the test sees exactly
 * what a child would have received. The keys are fakes assembled at run time.
 */

import { describe, expect, it } from 'vitest'

import { CHECKS, probeTableProblems, runChecks } from '../../../scripts/lib/live-check-plan.mjs'

const OPENAI = ['fake', 'openai', 'key'].join('-')
const OVERRIDE = 'http://127.0.0.1:9/v1'

interface Started {
  name: string
  values: Record<string, string | undefined>
}

async function plan(env: Record<string, string>, release = false) {
  const started: Started[] = []
  const lines: string[] = []
  const outcome = await runChecks({
    checks: CHECKS,
    env,
    release,
    start: (check: { name: string }, values: Record<string, string | undefined>) => {
      started.push({ name: check.name, values })
      return Promise.resolve({ ok: true, note: '' })
    },
    write: (line: string) => lines.push(line),
  })
  return { started, lines, ...outcome }
}

/** The names a child was given that carry a value. */
function present(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

describe('the live check deciding which children start', () => {
  it('validates the probe table it ships with', () => {
    expect(probeTableProblems()).toEqual([])
  })

  // gpt-image-2 rejects a transparent background, so only the older model is asked for one.
  it('asks gpt-image-2 for no background and checks alpha on gpt-image-1-mini only', () => {
    const check = CHECKS.find((candidate) => candidate.name === 'openai-images (image probes)')
    const probes = JSON.parse(check?.args[1] ?? '[]') as {
      model: string
      image?: { background?: string }
      expect?: { alpha?: boolean; pixels?: string }
    }[]
    const byModel = new Map(probes.map((entry) => [entry.model, entry]))
    expect(byModel.get('gpt-image-2')?.image).not.toHaveProperty('background')
    expect(byModel.get('gpt-image-2')?.expect).toEqual(
      expect.not.objectContaining({ alpha: true }),
    )
    expect(byModel.get('gpt-image-2')?.expect?.pixels).toBe('2048x2048')
    expect(byModel.get('gpt-image-1-mini')?.image?.background).toBe('transparent')
    expect(byModel.get('gpt-image-1-mini')?.expect?.alpha).toBe(true)
  })

  it('starts the OpenAI image probes with OPENAI_API_KEY alone when no override is set', async () => {
    const { started, ran } = await plan({ OPENAI_API_KEY: OPENAI })
    expect(started.map((child) => child.name)).toEqual([
      'openai-compatible',
      'openai-images (image probes)',
    ])
    expect(ran).toBe(2)
    expect(present(started[0]?.values ?? {})).toEqual({ OPENAI_API_KEY: OPENAI })
    expect(started[1]?.values).toEqual({ OPENAI_API_KEY: OPENAI })
  })

  it('never starts the OpenAI image probes, nor hands them the key, when OPENAI_BASE_URL is set', async () => {
    const { started, lines, ran, problems } = await plan({
      OPENAI_API_KEY: OPENAI,
      OPENAI_BASE_URL: OVERRIDE,
    })
    expect(started.map((child) => child.name)).toEqual(['openai-compatible'])
    expect(started[0]?.values).toEqual({ OPENAI_API_KEY: OPENAI, OPENAI_BASE_URL: OVERRIDE })
    expect(ran).toBe(1)
    expect(problems).toEqual([])
    expect(lines).toContain(
      'openai-images (image probes): skipped, OPENAI_BASE_URL is set, so OPENAI_API_KEY ' +
        'belongs to that endpoint and is not sent to the official one',
    )
  })

  it('gives every other child its own key and nothing else', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'a-key',
      GEMINI_API_KEY: 'g-key',
      OPENROUTER_API_KEY: 'r-key',
      OPENAI_API_KEY: OPENAI,
      OPENAI_BASE_URL: OVERRIDE,
    }
    const { started } = await plan(env)
    for (const child of started) {
      const names = Object.keys(present(child.values))
      const check = CHECKS.find((candidate) => candidate.name === child.name)
      expect(names[0]).toBe(check?.key)
      if (child.name !== 'openai-compatible') expect(names).toHaveLength(1)
    }
    expect(started.map((child) => child.name)).not.toContain('openai-images (image probes)')
  })

  it('counts a missing key as a problem in release mode, and starts nothing', async () => {
    const { started, problems } = await plan({}, true)
    expect(started).toEqual([])
    expect(problems).toHaveLength(CHECKS.length)
    expect(problems).toContain(
      'openrouter-images (image probes): OPENROUTER_API_KEY is not set',
    )
  })
})
