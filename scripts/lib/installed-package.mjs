/**
 * Confirming that what a project installed is the tarball that was meant to be installed,
 * and not a same-named package the registry happened to serve. Shared by the consumer
 * fixtures and the examples harness so the two cannot drift apart.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** sha256 of one file. */
export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Every path under `dir`, relative and sorted, so two trees hash the same way.
 *
 * `node_modules` is never descended into: a published tree does not contain one, and an
 * installed tree may have been given one by the package manager. Whatever is in there belongs
 * to some other package and says nothing about these bytes.
 */
function listFiles(dir, prefix, found) {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') listFiles(dir, path, found)
    } else found.push(path)
  }
  return found
}

/**
 * One hash over a whole directory: every path and every byte, in a fixed order. Hashing
 * a single file would miss a swapped declaration or an extra chunk.
 */
export function hashTree(dir) {
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
 * The manifest fields that decide which file an importer actually reaches. Byte-identical
 * `dist/` trees prove nothing if the manifest points into them somewhere else.
 */
const ENTRY_FIELDS = ['main', 'module', 'types', 'typings', 'exports']

/** Those fields, in a fixed order, as one comparable string. */
function entryPoints(manifest) {
  const found = {}
  for (const field of ENTRY_FIELDS) {
    if (manifest[field] !== undefined) found[field] = manifest[field]
  }
  return JSON.stringify(found)
}

/** A tarball is a few hundred kilobytes; anything slower than this is not unpacking. */
const UNPACK_DEADLINE = 60_000

/**
 * Unpacks the tarball once, so each project can be compared against the bytes that were
 * supposed to be installed rather than against whatever the registry happens to hold.
 */
export function unpackReference(tarballPath, workspace) {
  const reference = join(workspace, 'reference')
  mkdirSync(reference, { recursive: true })
  // Bounded and captured rather than inherited: the tarball is an input, and an input that
  // makes `tar` sit there or write pages of its own to the terminal is a failure to report,
  // not something to wait through.
  execFileSync('tar', ['-xzf', tarballPath, '-C', reference], {
    stdio: 'pipe',
    timeout: UNPACK_DEADLINE,
  })
  const packageRoot = join(reference, 'package')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    entryPoints: entryPoints(manifest),
    // Everything the tarball ships, not `dist/` alone: the licence, the readme and the
    // packaged documents are published bytes too, and a swap in any of them is a swap.
    treeHash: hashTree(packageRoot),
  }
}

/**
 * Confirms the installed package is this tarball. Without it a project could pass on a
 * same-named package fetched from the registry, which is the one thing it must not do.
 */
export function checkInstalledIsTheTarball(project, reference, name, problems) {
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
  if (entryPoints(manifest) !== reference.entryPoints) {
    problems.push(`${name}: the installed package points at different entry points`)
  }
  if (hashTree(installed) !== reference.treeHash) {
    problems.push(`${name}: the installed files are not the ones in the tarball`)
  }
}
