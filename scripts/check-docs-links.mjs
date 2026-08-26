#!/usr/bin/env node
/**
 * Checks every markdown link in the repository the way GitHub will resolve it: relative
 * targets must exist, and `#fragment` anchors must match a heading slug in the target
 * document. External URLs are counted but never fetched — their health is a different
 * question, and this gate stays network-free and deterministic.
 *
 * The embedded slugger mirrors GitHub's, and is validated against fixed fixtures taken
 * from known GitHub outputs before anything is checked — never against expectations this
 * script generated for itself, so the checker cannot quietly agree with its own mistakes.
 * A heading character or a link form the fixtures do not cover fails the gate loudly
 * instead of being skipped.
 *
 * Usage: node scripts/check-docs-links.mjs
 * Exit codes: 0 every link resolves, 1 a broken link / unsupported form / failed slugger
 * self-test, 2 bad arguments.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const USAGE = 'usage: check-docs-links.mjs\n'

// ——— slugger ———

/**
 * GitHub's slug algorithm for the character classes this repository actually uses:
 * markdown formatting is stripped, the text is lowercased, characters outside
 * letters/digits/space/hyphen/underscore are removed, then spaces become hyphens.
 * Duplicate slugs in one document get `-1`, `-2`, … suffixes.
 */
function slugOf(headingText) {
  return headingText
    .replace(/[`*]/g, '') // inline-code and emphasis markers render away before slugging
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

/**
 * Exactly the character classes the fixtures below prove `slugOf` handles the way GitHub
 * does. A heading using anything else fails the gate loudly — the maintainer then adds a
 * fixture with the known GitHub output and widens this set, never the other way around.
 */
const COVERED_HEADING = /^[\p{L}\p{N} `*\-.():;+,/'—]*$/u

/**
 * Known GitHub outputs, not outputs of `slugOf` — the point is that the two agree.
 * Sourced from GitHub's rendering of these exact heading texts. Together they cover every
 * character `COVERED_HEADING` admits.
 */
const SLUG_FIXTURES = [
  ['Quickstart', 'quickstart'],
  ['When fallback fires', 'when-fallback-fires'],
  ['Runtime config', 'runtime-config'],
  ['Output: from model text to typed data', 'output-from-model-text-to-typed-data'],
  [
    '5c. Built-in adapter wire contracts (research-verified 2026-08-10; primary sources linked)',
    '5c-built-in-adapter-wire-contracts-research-verified-2026-08-10-primary-sources-linked',
  ],
  ['`openaiCompatible`', 'openaicompatible'],
  ['`src/core`', 'srccore'],
  [
    'Cost and usage model (scope-limited by design)',
    'cost-and-usage-model-scope-limited-by-design',
  ],
  ['ESM + CommonJS', 'esm--commonjs'],
  ['A — B', 'a--b'],
  ["Don't panic", 'dont-panic'],
  ['One, two', 'one-two'],
  ['**Bold** move', 'bold-move'],
]

function sluggerSelfTest(problems) {
  for (const [heading, expected] of SLUG_FIXTURES) {
    const actual = slugOf(heading)
    if (actual !== expected) {
      problems.push(
        `slugger self-test: '${heading}' → '${actual}', but GitHub produces '${expected}'`,
      )
    }
  }
  // Document-level behaviour, same fixed-expectation discipline: duplicate headings get
  // GitHub's -1, -2 suffixes.
  const duplicates = headingSlugs(['# Foo', '# Foo', '# Bar'], '(self-test)', problems)
  for (const slug of ['foo', 'foo-1', 'bar']) {
    if (!duplicates.has(slug)) {
      problems.push(`slugger self-test: duplicate-heading suffixes lost the anchor '#${slug}'`)
    }
  }
}

// ——— markdown reading ———

/**
 * Two views of the file with line numbers preserved. Fenced code blocks are blanked in
 * both — nothing inside a fence is markup. Inline code spans are blanked only in the
 * link-scanning view: a bracket inside backticks is not a link, but a heading's inline
 * code DOES contribute its text to GitHub's slug, so the heading view keeps it.
 */
function withoutCode(text) {
  const lines = text.split('\n')
  let fenced = false
  const forHeadings = []
  const forLinks = []
  for (const line of lines) {
    if (line.startsWith('```')) {
      fenced = !fenced
      forHeadings.push('')
      forLinks.push('')
      continue
    }
    if (fenced) {
      forHeadings.push('')
      forLinks.push('')
      continue
    }
    forHeadings.push(line)
    forLinks.push(line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length)))
  }
  return { forHeadings, forLinks }
}

/** `{ slug }` for every heading, GitHub duplicate suffixes applied. */
function headingSlugs(lines, file, problems) {
  const counts = new Map()
  const slugs = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line === undefined ? null : /^#{1,6} (.*)$/.exec(line)
    if (match === null) continue
    const text = (match[1] ?? '').trim()
    if (!COVERED_HEADING.test(text)) {
      problems.push(
        `${file}:${String(index + 1)}: heading contains a character the slugger's fixtures do not cover: '${text}'`,
      )
      continue
    }
    const base = slugOf(text)
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    slugs.add(seen === 0 ? base : `${base}-${String(seen)}`)
  }
  return slugs
}

/** Inline links and images: `[text](target)` / `![alt](target)`, optional title dropped. */
function linksOf(lines, file, problems) {
  const links = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const at = `${file}:${String(index + 1)}`
    if (/^\s*\[[^\]]+\]:\s/.test(line)) {
      problems.push(`${at}: reference-style link definitions are not supported by this gate`)
      continue
    }
    if (/<a\s|<img\s/i.test(line)) {
      problems.push(`${at}: raw HTML links are not supported by this gate`)
      continue
    }
    for (const match of line.matchAll(
      /\[[^\]]*\]\(([^()\s]+(?:\([^()]*\))?)(?:\s+"[^"]*")?\)/g,
    )) {
      links.push({ target: match[1], at })
    }
    // Autolinks are always absolute URLs, so they join the recorded-not-fetched externals.
    for (const match of line.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
      links.push({ target: match[1], at })
    }
    for (const match of line.matchAll(/\[[^\]]*\]\[[^\]]*\]/g)) {
      problems.push(`${at}: reference-style link '${match[0]}' is not supported by this gate`)
    }
  }
  return links
}

// ——— resolution ———

function main() {
  if (process.argv.length > 2) {
    process.stderr.write(USAGE)
    return 2
  }

  const problems = []
  sluggerSelfTest(problems)
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }

  // Tracked files plus new not-yet-committed ones, so a page works before its first commit.
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => file !== '')
    .sort()

  const documents = new Map()
  for (const file of files) {
    const { forHeadings, forLinks } = withoutCode(readFileSync(join(ROOT, file), 'utf8'))
    documents.set(file, { lines: forLinks, slugs: headingSlugs(forHeadings, file, problems) })
  }

  let internal = 0
  let external = 0
  for (const [file, document] of documents) {
    for (const { target, at } of linksOf(document.lines, file, problems)) {
      if (/^(https?:\/\/|mailto:)/.test(target)) {
        external += 1
        continue
      }
      if (target.includes('://')) {
        problems.push(`${at}: unsupported scheme in '${target}'`)
        continue
      }
      if (target.startsWith('/')) {
        problems.push(`${at}: root-relative target '${target}' does not resolve on GitHub`)
        continue
      }
      internal += 1
      const hash = target.indexOf('#')
      const pathPart = hash === -1 ? target : target.slice(0, hash)
      const fragment = hash === -1 ? null : target.slice(hash + 1)

      let resolvedFile = file
      if (pathPart !== '') {
        const resolved = normalize(join(dirname(file), pathPart))
        if (resolved.split(sep)[0] === '..') {
          problems.push(`${at}: '${target}' escapes the repository`)
          continue
        }
        if (!existsSync(join(ROOT, resolved))) {
          problems.push(`${at}: '${target}' → ${resolved} does not exist`)
          continue
        }
        resolvedFile = resolved.replaceAll(sep, '/')
      }
      if (fragment === null) continue
      const targetDocument = documents.get(resolvedFile)
      if (targetDocument === undefined) {
        problems.push(
          `${at}: '${target}' carries an anchor, but ${resolvedFile} is not a markdown document this gate reads`,
        )
        continue
      }
      if (!targetDocument.slugs.has(fragment)) {
        problems.push(`${at}: no heading in ${resolvedFile} produces the anchor '#${fragment}'`)
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }
  process.stdout.write(
    `${String(internal)} internal links resolve across ${String(files.length)} markdown files (${String(external)} external links recorded, not fetched)\n`,
  )
  return 0
}

process.exitCode = main()
