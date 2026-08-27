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

/** Every path under `dir`, relative, so two trees hash the same way. Nothing is skipped. */
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

/** A tarball is a few hundred kilobytes; anything slower than this is not unpacking. */
const UNPACK_DEADLINE = 60_000

/**
 * Unpacks the tarball once, so each project can be compared against the bytes that were
 * supposed to be installed rather than against whatever the registry happens to hold.
 *
 * @throws `Error` when the tarball ships a `node_modules`. Trees are hashed whole, so one
 * would be compared against whatever the package manager installed and fail as swapped bytes
 * rather than as the packaging fault it is.
 */
export function unpackReference(tarballPath, workspace) {
  const reference = join(workspace, 'reference')
  mkdirSync(reference, { recursive: true })
  // The tarball is untrusted input: bound the unpack and capture its output.
  execFileSync('tar', ['-xzf', tarballPath, '-C', reference], {
    stdio: 'pipe',
    timeout: UNPACK_DEADLINE,
  })
  const packageRoot = join(reference, 'package')
  const bundled = listFiles(packageRoot, '', []).find(
    (path) => path === 'node_modules' || path.startsWith('node_modules/'),
  )
  if (bundled !== undefined) {
    throw new Error(`the tarball ships a node_modules directory (${bundled})`)
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    entryPoints: entryPoints(manifest),
    // Everything the tarball ships, not `dist/` alone.
    treeHash: hashTree(packageRoot),
  }
}

/**
 * Confirms the installed package is this tarball. Without it a project could pass on a
 * same-named package fetched from the registry, which is the one thing it must not do.
 */
export function checkInstalledIsTheTarball(project, reference, name, problems) {
  const installed = join(project, 'node_modules', 'llmdispatch')
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
