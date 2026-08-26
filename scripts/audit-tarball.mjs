#!/usr/bin/env node
/**
 * Inspects a packed tarball before anyone can install it.
 *
 * It answers four questions about the exact bytes that would be published: does it
 * contain only the files it is supposed to contain, does it try to run anything at
 * install time, does it oblige an adopter to install anything beyond the one peer
 * dependency, and does its content survive the tree scan.
 *
 * Usage: node scripts/audit-tarball.mjs <path-to-tgz>
 * Exit codes: 0 clean, 1 a problem was found, 2 wrong usage or an internal error.
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Everything the tarball may contain. `dist/` is a prefix; the rest are exact paths. */
const ALLOWED_FILES = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'docs/providers.md',
  'docs/spec.md',
])
const ALLOWED_PREFIXES = ['dist/']
/** Files the tarball must contain, or an adopter loses the licence, the docs, or the code. */
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'docs/providers.md',
  'docs/spec.md',
]
/** The only shapes `dist/` may take: code, declarations, and the maps that go with them. */
const ALLOWED_DIST_SUFFIXES = ['.js', '.cjs', '.d.ts', '.d.cts', '.js.map', '.cjs.map']

/**
 * Manifest fields that describe the published contract. A packed tarball whose values
 * differ from the ones in the repository is not the package that was checked.
 */
const CONTRACT_FIELDS = [
  'name',
  'version',
  'type',
  'main',
  'types',
  'exports',
  'files',
  'sideEffects',
  'engines',
  'peerDependencies',
  'publishConfig',
  'license',
]

/** The one peer dependency an adopter is expected to have installed already. */
const EXPECTED_PEER = 'zod'
/** Manifest fields that would add an install, a binary, or a bundled tree. */
const FORBIDDEN_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]

/**
 * Script names npm runs on its own around install, pack, and publish. Any of them in a
 * published manifest means installing this package can execute code, which it must not.
 */
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'prepare',
  'publish',
  'postpublish',
  'dependencies',
])

function listFiles(root, prefix, found) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) listFiles(root, path, found)
    else found.push(path)
  }
  return found
}

function checkFileList(files, problems) {
  for (const file of files) {
    const allowed = ALLOWED_FILES.has(file) || ALLOWED_PREFIXES.some((p) => file.startsWith(p))
    if (!allowed) problems.push(`unexpected file in the tarball: ${file}`)
  }
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) problems.push(`the tarball has no ${required}`)
  }

  const distFiles = files.filter((file) => file.startsWith('dist/'))
  if (distFiles.length === 0) problems.push('the tarball ships an empty dist/')
  for (const file of distFiles) {
    if (!ALLOWED_DIST_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
      problems.push(`dist/ carries something that is neither code, types, nor a map: ${file}`)
    }
  }
}

function checkManifest(manifest, problems) {
  const scripts = manifest.scripts ?? {}
  for (const name of Object.keys(scripts)) {
    if (LIFECYCLE_SCRIPTS.has(name) || /^(pre|post)/.test(name)) {
      problems.push(`the published manifest would run a script named '${name}'`)
    }
  }

  for (const field of FORBIDDEN_DEPENDENCY_FIELDS) {
    const declared = manifest[field]
    const names = Array.isArray(declared) ? declared : Object.keys(declared ?? {})
    if (names.length > 0) {
      problems.push(`the published manifest declares ${field}: ${names.join(', ')}`)
    }
  }

  // Exactly one peer dependency. A second one is a second thing an adopter must install.
  const peers = Object.keys(manifest.peerDependencies ?? {})
  if (peers.length !== 1 || peers[0] !== EXPECTED_PEER) {
    problems.push(`peerDependencies should be ${EXPECTED_PEER} alone, not: ${peers.join(', ')}`)
  }

  // An optional peer is a peer that can be missing; the whole point of this one is that
  // it cannot be.
  if (manifest.peerDependenciesMeta !== undefined) {
    problems.push('the published manifest marks a peer dependency optional')
  }

  // A `bin` entry puts an executable on the adopter's path; this is a library.
  const binaries = Object.keys(
    typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
  )
  if (binaries.length > 0) {
    problems.push(`the published manifest installs an executable: ${binaries.join(', ')}`)
  }
}

/**
 * Compares the packed manifest with the one in the repository. `npm pack` is supposed to
 * copy these fields verbatim; if it did not, something rewrote the manifest between the
 * commit and the tarball.
 */
function checkAgainstRepository(manifest, problems) {
  const committed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const field of CONTRACT_FIELDS) {
    const packed = JSON.stringify(manifest[field] ?? null)
    const expected = JSON.stringify(committed[field] ?? null)
    if (packed !== expected) {
      problems.push(`the packed manifest's '${field}' is not the one in the repository`)
    }
  }
}

function main() {
  const [tarball] = process.argv.slice(2)
  if (tarball === undefined) {
    process.stderr.write('usage: audit-tarball.mjs <path-to-tgz>\n')
    return 2
  }
  const tarballPath = resolve(tarball)
  if (!existsSync(tarballPath)) {
    process.stderr.write(`no such file: ${tarball}\n`)
    return 2
  }

  const digest = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  const workspace = mkdtempSync(join(tmpdir(), 'tarball-audit-'))
  const problems = []
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', workspace], { stdio: 'inherit' })
    const unpacked = join(workspace, 'package')
    if (!existsSync(unpacked)) {
      process.stderr.write("the tarball has no 'package' directory\n")
      return 2
    }

    const files = listFiles(unpacked, '', []).sort()
    checkFileList(files, problems)
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
    checkManifest(manifest, problems)
    checkAgainstRepository(manifest, problems)

    const scan = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'scan-denylist.mjs'), unpacked],
      {
        stdio: 'inherit',
      },
    )
    if (scan.status !== 0) problems.push('the tree scan reported findings inside the tarball')

    process.stdout.write(`${String(files.length)} files\n`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  process.stdout.write(`sha256 ${digest}\n`)
  return problems.length === 0 ? 0 : 1
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`audit failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
  process.exitCode = 2
}
