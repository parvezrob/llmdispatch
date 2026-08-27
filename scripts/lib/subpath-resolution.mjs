/**
 * Where the published subpaths actually resolve to, asked from inside the project that
 * installed the package.
 *
 * A checkout of this package resolves its own name: the manifest's `name` together with its
 * `exports` makes `llmswitch/postgres` reach `dist/` from any file inside the working tree.
 * A verification runner left in the repository would therefore import the tree it is meant to
 * be judging and report a pass with the tarball never involved. So the runner and this module
 * are copied into the scratch project, next to the `node_modules` the tarball was installed
 * into, and every subpath is resolved from there before anything is imported.
 *
 * This module must sit in that project's root directory: the project is the directory this
 * file is in, and resolution is asked for from this file's own location.
 *
 * @module
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every subpath the manifest publishes. All three have to come from the installed copy. */
export const SUBPATHS = ['llmswitch', 'llmswitch/postgres', 'llmswitch/conformance']

/** The directory this file was copied into, which is the project that did the installing. */
function projectDirectory() {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Confirms every subpath resolves inside this project's own copy of the package.
 *
 * @returns Each subpath with the file it resolved to, in the order they were asked for.
 * @throws `Error` when the package is not installed here, when a subpath does not resolve at
 * all, or when one resolves to a file anywhere outside `node_modules/llmswitch`.
 */
export function assertInstalledPackageResolves() {
  const installed = join(projectDirectory(), 'node_modules', 'llmswitch')
  if (!existsSync(installed)) {
    throw new Error(`the package is not installed at ${installed}`)
  }
  // Resolved paths come back with symlinks followed — a package manager that links its store
  // would otherwise compare a link against its target and reject an honest install.
  const root = realpathSync(installed)
  const resolved = []
  for (const subpath of SUBPATHS) {
    let url
    try {
      url = import.meta.resolve(subpath)
    } catch {
      throw new Error(`'${subpath}' does not resolve from ${projectDirectory()}`)
    }
    if (!url.startsWith('file:')) {
      throw new Error(`'${subpath}' resolves to ${url}, which is not a file`)
    }
    const file = realpathSync(fileURLToPath(url))
    if (file !== root && !file.startsWith(root + sep)) {
      throw new Error(`'${subpath}' resolves to ${file}, which is not under ${root}`)
    }
    resolved.push({ subpath, file })
  }
  return resolved
}
