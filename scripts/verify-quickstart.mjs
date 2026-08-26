#!/usr/bin/env node
/**
 * Follows the README quickstart literally, in a clean directory, against a packed tarball.
 *
 * Extraction is the strict one the fixture checker also applies: the `## Quickstart`
 * section must contain exactly one `bash` install fence followed by one `ts` code fence.
 * The install is the documented command with only the unpublished registry argument
 * `llmswitch` replaced by the tarball path; the code fence is written byte-for-byte to its
 * own file — never edited, wrapped or rewritten — and executed by a two-line harness that
 * imports it. Provider API keys are scrubbed from the child environment, so the run cannot
 * become live billed traffic: without a key, the documented outcome is an `LLMSwitchError`
 * with code `INVALID_CONFIG` from the unresolvable key, and that exact rejection is the
 * pass condition. Anything else — a ReferenceError, a different code, a run that resolves —
 * means the printed quickstart is wrong.
 *
 * Needs Node >= 23.6 (native type stripping executes the `ts` fence as printed) and network
 * access for the documented `npm install` of `zod`.
 *
 * Usage: node scripts/verify-quickstart.mjs [path-to-tarball]
 *   With no argument, packs the working tree first. CI passes the audited tarball.
 * Exit codes: 0 the quickstart behaves as printed, 1 it does not, 2 bad arguments.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const README = join(ROOT, 'README.md')
const USAGE = 'usage: verify-quickstart.mjs [path-to-tarball]\n'
const SCRUBBED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']

/** The quickstart's two fences, or `null` after reporting why extraction refused. */
function extractQuickstart(problems) {
  const lines = readFileSync(README, 'utf8').split('\n')
  const start = lines.indexOf('## Quickstart')
  if (start === -1) {
    problems.push("README.md has no '## Quickstart' heading")
    return null
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ') === true) {
      end = index
      break
    }
  }
  const fences = []
  let open = null
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined || !line.startsWith('```')) continue
    if (open === null) {
      open = { info: line.slice(3).trim(), afterOpener: index + 1 }
    } else {
      fences.push({ ...open, closer: index })
      open = null
    }
  }
  const [installFence, codeFence] = fences
  if (
    open !== null ||
    fences.length !== 2 ||
    installFence?.info !== 'bash' ||
    codeFence?.info !== 'ts'
  ) {
    problems.push(
      `README.md ## Quickstart: expected exactly one \`\`\`bash fence then one \`\`\`ts fence, found [${fences.map((fence) => fence.info || '(none)').join(', ')}]${open === null ? '' : ' plus an unclosed fence'}`,
    )
    return null
  }
  return {
    install: lines.slice(installFence.afterOpener, installFence.closer).join('\n').trim(),
    code: `${lines.slice(codeFence.afterOpener, codeFence.closer).join('\n')}\n`,
  }
}

/** The two-line harness: import the printed file, require the documented rejection. */
const HARNESS = `try {
  await import('./quickstart.ts')
  console.error('the quickstart ran to completion without an API key — expected INVALID_CONFIG')
  process.exit(1)
} catch (error) {
  if (error?.name === 'LLMSwitchError' && error?.code === 'INVALID_CONFIG') {
    console.log('the quickstart behaves as printed: keyless run ends in INVALID_CONFIG')
    process.exit(0)
  }
  console.error('the quickstart failed, but not the documented way:', error)
  process.exit(1)
}
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.length > 1) {
    process.stderr.write(USAGE)
    return 2
  }

  const problems = []
  const quickstart = extractQuickstart(problems)
  if (quickstart === null) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }
  if (quickstart.install !== 'npm install llmswitch zod') {
    process.stderr.write(
      `README.md ## Quickstart: the install fence reads '${quickstart.install}', not the documented 'npm install llmswitch zod' this script derives from\n`,
    )
    return 1
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SCRUBBED_KEYS.includes(key)),
  )

  const directory = mkdtempSync(join(tmpdir(), 'llmswitch-quickstart-'))
  try {
    let tarball = argv[0]
    if (tarball === undefined) {
      const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
        cwd: ROOT,
        encoding: 'utf8',
        env: environment,
      })
      tarball = join(directory, JSON.parse(packed)[0].filename)
    } else if (!isAbsolute(tarball)) {
      tarball = resolve(tarball)
    }

    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: 'quickstart', private: true, type: 'module' }, null, 2)}\n`,
    )
    // The documented command, with only the unpublished registry argument replaced.
    const install = quickstart.install
      .split(' ')
      .map((word) => (word === 'llmswitch' ? tarball : word))
    execFileSync('npm', install.slice(1), {
      cwd: directory,
      env: environment,
      stdio: 'inherit',
    })

    writeFileSync(join(directory, 'quickstart.ts'), quickstart.code)
    writeFileSync(join(directory, 'main.mjs'), HARNESS)
    execFileSync(process.execPath, ['main.mjs'], {
      cwd: directory,
      env: environment,
      stdio: 'inherit',
    })
    return 0
  } catch {
    process.stderr.write('the quickstart walk-through failed — output above\n')
    return 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

process.exitCode = main()
