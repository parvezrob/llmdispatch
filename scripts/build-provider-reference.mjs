#!/usr/bin/env node
/**
 * Builds `docs/providers.md` from spec §5c — the research-verified adapter wire contracts.
 *
 * The reference is a verbatim slice, not a rewrite: the section between the `### 5c.`
 * heading and the next heading of equal or higher rank is copied as it stands, split into
 * one page section per adapter factory at the bold `**`factory(...)`**` paragraph leads the
 * spec already uses. The generator authors no provider fact of its own — the banner and the
 * one structural label are fixed strings, every name and every sentence comes from the
 * spec — so the page cannot drift from the contract it documents. Anything it cannot parse
 * exactly (missing heading, missing boundary, an unexpected number of factory leads) is a
 * loud failure, never a guess.
 *
 * Usage: node scripts/build-provider-reference.mjs [--check]
 *   (no flag)  write docs/providers.md
 *   --check    build in memory and fail if docs/providers.md differs (the drift gate)
 * Exit codes: 0 built or identical, 1 drift or unparseable spec, 2 bad arguments.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SPEC = join(ROOT, 'docs', 'spec.md')
const OUT = join(ROOT, 'docs', 'providers.md')
const USAGE = 'usage: build-provider-reference.mjs [--check]\n'

const FACTORY_COUNT = 3 // structural arity: a new adapter must extend this deliberately
const LEAD = /^\*\*`([A-Za-z][A-Za-z0-9]*)\(/

/** The §5c body, or `null` after reporting why it could not be sliced. */
function sliceSection(lines, problems) {
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^### 5c\. /.test(lines[index])) starts.push(index)
  }
  const start = starts[0]
  if (starts.length !== 1 || start === undefined) {
    problems.push(
      `docs/spec.md: expected exactly one '### 5c.' heading, found ${String(starts.length)}`,
    )
    return null
  }
  let end = null
  for (let index = start + 1; index < lines.length; index += 1) {
    // Equal or higher rank than the `###` opener: `#`, `##` or `###`. §5c is the last
    // subsection of its parent today, so the boundary is `## 6.` — assuming a later `###`
    // would swallow the sections that follow.
    if (/^#{1,3} /.test(lines[index])) {
      end = index
      break
    }
  }
  if (end === null) {
    // Fail closed: with no following heading the slice would silently swallow the rest of
    // the spec, which is exactly the drift this generator exists to prevent.
    problems.push("docs/spec.md: no heading of rank 1-3 follows '### 5c.' to bound the slice")
    return null
  }
  return lines.slice(start + 1, end)
}

/** Leading and trailing blank lines removed; interior lines untouched. */
function trimmed(lines) {
  let first = 0
  let last = lines.length
  while (first < last && lines[first].trim() === '') first += 1
  while (last > first && lines[last - 1].trim() === '') last -= 1
  return lines.slice(first, last)
}

/** The generated page, or `null` after reporting what failed to parse. */
function build(problems) {
  const lines = readFileSync(SPEC, 'utf8').split('\n')
  const body = sliceSection(lines, problems)
  if (body === null) return null

  const leads = []
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index]
    const match = line === undefined ? null : LEAD.exec(line)
    const name = match?.[1]
    if (name !== undefined) leads.push({ index, name })
  }
  const names = leads.map((lead) => lead.name)
  const firstLead = leads[0]
  if (
    leads.length !== FACTORY_COUNT ||
    firstLead === undefined ||
    new Set(names).size !== FACTORY_COUNT
  ) {
    problems.push(
      `docs/spec.md §5c: expected ${String(FACTORY_COUNT)} distinct factory leads (\`**\`factory(\`**\` paragraph openers), found [${names.join(', ')}]`,
    )
    return null
  }

  const chunks = []
  chunks.push(
    '<!-- Generated from docs/spec.md §5c by scripts/build-provider-reference.mjs — do not',
    '     edit this file. Edit the spec, then run `npm run docs:providers`. -->',
    '',
    '# Provider wire reference',
    '',
    '> Generated verbatim from [docs/spec.md](./spec.md) §5c, the authoritative wire',
    '> contracts for the built-in adapters. Edit the spec, then run `npm run docs:providers`.',
    '',
    '## Contents',
    '',
    '- [All adapters](#all-adapters)',
  )
  for (const name of names) chunks.push(`- [\`${name}\`](#${name.toLowerCase()})`)
  chunks.push('', '## All adapters', '')
  chunks.push(...trimmed(body.slice(0, firstLead.index)))
  for (let index = 0; index < leads.length; index += 1) {
    const lead = leads[index]
    if (lead === undefined) continue
    const to = leads[index + 1]?.index ?? body.length
    chunks.push('', `## \`${lead.name}\``, '')
    chunks.push(...trimmed(body.slice(lead.index, to)))
  }
  chunks.push('')
  return chunks.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  let check = false
  for (const argument of argv) {
    if (argument !== '--check' || check) {
      process.stderr.write(`unknown or repeated argument '${argument}'\n${USAGE}`)
      return 2
    }
    check = true
  }

  const problems = []
  const page = build(problems)
  if (page === null) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }

  const out = relative(ROOT, OUT)
  if (check) {
    let existing
    try {
      existing = readFileSync(OUT, 'utf8')
    } catch {
      process.stderr.write(`${out} is missing — run 'npm run docs:providers'\n`)
      return 1
    }
    if (existing !== page) {
      process.stderr.write(
        `${out} does not match docs/spec.md §5c — run 'npm run docs:providers' and commit the result\n`,
      )
      return 1
    }
    process.stdout.write(`${out} matches docs/spec.md §5c\n`)
    return 0
  }

  writeFileSync(OUT, page)
  process.stdout.write(`wrote ${out}\n`)
  return 0
}

process.exitCode = main()
