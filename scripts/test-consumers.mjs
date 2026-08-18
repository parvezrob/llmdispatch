#!/usr/bin/env node
/**
 * Installs a packed tarball into three throwaway projects and checks that each one can
 * reach all three entry points the way its own module system reaches them.
 *
 * The tarball is an argument on purpose: this script never packs. Whatever was audited
 * is what gets installed, and its hash is recorded before and after so a run cannot
 * quietly test something else. The projects are created outside the repository so no
 * parent `node_modules` and no path back into `src/` can rescue a broken package.
 *
 * Usage: node scripts/test-consumers.mjs <path-to-tgz>
 * Exit codes: 0 all three fixtures pass, 1 a fixture failed, 2 wrong usage.
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const FIXTURES = join(ROOT, 'test', 'consumers')

/** Pinned so a fixture run is reproducible; change them here and nowhere else. */
const ZOD = 'zod@4.4.3'
const TYPESCRIPT = 'typescript@5.9.3'

const SUBPATHS = ['llmswitch', 'llmswitch/postgres', 'llmswitch/conformance']
const DECLARATIONS = {
  index: 'llmswitch',
  postgres: 'llmswitch/postgres',
  conformance: 'llmswitch/conformance',
}

/** Enough for any plausible run; more than this is a runaway, and a runaway is a failure. */
const OUTPUT_LIMIT = 64 * 1024 * 1024

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every path under `dir`, relative and sorted, so two trees hash the same way. */
function listFiles(dir, prefix, found) {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) listFiles(dir, path, found)
    else found.push(path)
  }
  return found
}

/**
 * One hash over a whole directory: every path and every byte, in a fixed order. Hashing
 * a single file would miss a swapped declaration or an extra chunk.
 */
function hashTree(dir) {
  const digest = createHash('sha256')
  for (const path of listFiles(dir, '', []).sort()) {
    digest
      .update(path)
      .update('\0')
      .update(readFileSync(join(dir, path)))
      .update('\0')
  }
  return digest.digest('hex')
}

/**
 * Unpacks the tarball once, so each fixture can be compared against the bytes that were
 * supposed to be installed rather than against whatever the registry happens to hold.
 */
function unpackReference(tarballPath, workspace) {
  const reference = join(workspace, 'reference')
  mkdirSync(reference, { recursive: true })
  execFileSync('tar', ['-xzf', tarballPath, '-C', reference], { stdio: 'inherit' })
  const packageRoot = join(reference, 'package')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    distHash: hashTree(join(packageRoot, 'dist')),
  }
}

/**
 * Confirms the installed package is this tarball. Without it a fixture could pass on a
 * same-named package fetched from the registry, which is the one thing it must not do.
 */
function checkInstalledIsTheTarball(project, reference, name, problems) {
  const installed = join(project, 'node_modules', 'llmswitch')
  if (!existsSync(installed)) {
    problems.push(`${name}: the package was not installed`)
    return
  }
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  if (manifest.name !== reference.name || manifest.version !== reference.version) {
    problems.push(
      `${name}: installed ${String(manifest.name)}@${String(manifest.version)}, ` +
        `expected ${reference.name}@${reference.version}`,
    )
  }
  const dist = join(installed, 'dist')
  if (!existsSync(dist) || hashTree(dist) !== reference.distHash) {
    problems.push(`${name}: the installed dist/ is not the one in the tarball`)
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: OUTPUT_LIMIT,
  })
  // `error` covers the command never starting and its output overflowing the buffer.
  // Either way the run proved nothing, so it is a failure and not a quiet pass.
  const failure = result.error
  return {
    ok: failure === undefined && result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${failure === undefined ? '' : `\n${failure.message}`}`,
  }
}

/**
 * Reads `tsc --traceResolution` output into triples of (specifier, importing file,
 * resolved file). The two lines always come in that order, so the importer is simply
 * the last one announced.
 */
function readResolutions(trace) {
  const resolutions = []
  let importer = null
  for (const line of trace.split('\n')) {
    const start = /Resolving module '([^']+)' from '([^']+)'/.exec(line)
    if (start?.[1] !== undefined && start[2] !== undefined) {
      importer = { specifier: start[1], from: start[2] }
      continue
    }
    const end = /was successfully resolved to '([^']+)'/.exec(line)
    if (end?.[1] !== undefined && importer !== null) {
      resolutions.push({ ...importer, to: end[1] })
      importer = null
    }
  }
  return resolutions
}

/**
 * The point of the TypeScript fixture: an `.mts` file must land on the `import`
 * declarations and a `.cts` file on the `require` ones. A single shared declaration
 * file would compile here and break in a consumer's editor.
 */
function checkResolutions(trace, problems) {
  const resolutions = readResolutions(trace)
  const cases = [
    { file: 'a.mts', extension: '.d.ts' },
    { file: 'b.cts', extension: '.d.cts' },
  ]
  for (const { file, extension } of cases) {
    for (const [entry, specifier] of Object.entries(DECLARATIONS)) {
      const expected = `node_modules/llmswitch/dist/${entry}${extension}`
      const hit = resolutions.some(
        (r) => r.specifier === specifier && r.from.endsWith(file) && r.to.endsWith(expected),
      )
      if (!hit) problems.push(`${file} did not resolve '${specifier}' to ${expected}`)
    }
  }
}

function runFixture(name, workspace, tarballPath, reference, problems) {
  const project = join(workspace, name)
  cpSync(join(FIXTURES, name), project, { recursive: true })

  const packages = [tarballPath, ZOD, ...(name === 'ts' ? [TYPESCRIPT] : [])]
  const install = run('npm', ['install', '--ignore-scripts', '--no-save', ...packages], project)
  if (!install.ok) {
    problems.push(`${name}: install failed\n${install.output}`)
    return
  }
  checkInstalledIsTheTarball(project, reference, name, problems)

  if (name === 'esm' || name === 'cjs') {
    const entry = name === 'esm' ? 'index.mjs' : 'index.cjs'
    const result = run(process.execPath, [entry], project)
    if (!result.ok) problems.push(`${name}: ${entry} did not run\n${result.output}`)
    return
  }

  const tsc = join(project, 'node_modules', '.bin', 'tsc')
  const compile = run(tsc, ['--noEmit', '-p', 'tsconfig.json'], project)
  if (!compile.ok) {
    problems.push(`${name}: compilation failed\n${compile.output}`)
    return
  }
  const trace = run(tsc, ['--noEmit', '-p', 'tsconfig.json', '--traceResolution'], project)
  if (!trace.ok) {
    problems.push(`${name}: could not trace module resolution\n${trace.output}`)
    return
  }
  checkResolutions(trace.output, problems)
}

function main() {
  const [tarball] = process.argv.slice(2)
  if (tarball === undefined) {
    process.stderr.write('usage: test-consumers.mjs <path-to-tgz>\n')
    return 2
  }
  const tarballPath = resolve(tarball)
  if (!existsSync(tarballPath)) {
    process.stderr.write(`no such file: ${tarball}\n`)
    return 2
  }

  const before = hash(tarballPath)
  const workspace = mkdtempSync(join(tmpdir(), 'consumer-fixtures-'))
  const problems = []
  try {
    const reference = unpackReference(tarballPath, workspace)
    for (const name of ['esm', 'cjs', 'ts']) {
      runFixture(name, workspace, tarballPath, reference, problems)
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  if (hash(tarballPath) !== before)
    problems.push('the tarball changed while it was being tested')

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  process.stdout.write(
    problems.length === 0
      ? `all fixtures reached ${String(SUBPATHS.length)} entry points, recognised a ProviderError ` +
          'across the ESM and CommonJS builds in both directions, rejected the values that only ' +
          'look like one, and narrowed LLMSwitchError by code — ' +
          `from sha256 ${before}\n`
      : `${String(problems.length)} problem(s)\n`,
  )
  return problems.length === 0 ? 0 : 1
}

process.exitCode = main()
