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

/**
 * Unpacks the tarball once, so each project can be compared against the bytes that were
 * supposed to be installed rather than against whatever the registry happens to hold.
 */
export function unpackReference(tarballPath, workspace) {
  const reference = join(workspace, 'reference')
  mkdirSync(reference, { recursive: true })
  execFileSync('tar', ['-xzf', tarballPath, '-C', reference], { stdio: 'inherit' })
  const packageRoot = join(reference, 'package')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    entryPoints: entryPoints(manifest),
    distHash: hashTree(join(packageRoot, 'dist')),
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
  const dist = join(installed, 'dist')
  if (!existsSync(dist) || hashTree(dist) !== reference.distHash) {
    problems.push(`${name}: the installed dist/ is not the one in the tarball`)
  }
}
