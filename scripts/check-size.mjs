#!/usr/bin/env node
/**
 * Guards what an application actually downloads when it imports this package.
 *
 * It starts at the root entry, follows every static import inside `dist/`, gzips the
 * result, and compares it with `sizeBudget` in the manifest. Dynamic imports are not
 * followed: a bundler does not include them in the initial chunk either.
 *
 * Usage: node scripts/check-size.mjs
 */

import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'dist', 'index.js')

/** Matches the specifier of a static `import`, `export … from`, or bare `import`. */
const STATIC_SPECIFIER = /(?:\bfrom|\bimport)\s*['"]([^'"]+)['"]/g

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(fromFile), specifier)
  for (const candidate of [target, `${target}.js`, join(target, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every file the entry pulls in at load time, entry first, each visited once. */
function collectChunks(entry) {
  const seen = new Set()
  const ordered = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    ordered.push({ file, source })
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const next = resolveLocal(file, match[1])
      if (next !== null) queue.push(next)
    }
  }
  return ordered
}

function main() {
  if (!existsSync(ENTRY)) {
    process.stderr.write("dist/index.js is missing; run 'npm run build' first\n")
    return 2
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const budget = manifest.sizeBudget
  if (typeof budget !== 'number') {
    process.stderr.write("package.json has no numeric 'sizeBudget'\n")
    return 2
  }

  const chunks = collectChunks(ENTRY)
  const size = gzipSync(Buffer.from(chunks.map((chunk) => chunk.source).join('\n'))).byteLength
  const names = chunks.map((chunk) => relative(ROOT, chunk.file)).join(', ')
  process.stdout.write(
    `${String(size)} bytes gzipped of ${String(budget)} allowed (${names})\n`,
  )
  if (size > budget) {
    process.stderr.write(
      'the entry point grew past its budget: make it smaller, or raise sizeBudget deliberately\n',
    )
    return 1
  }
  return 0
}

process.exitCode = main()
