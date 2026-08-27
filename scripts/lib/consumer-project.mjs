/**
 * The scratch project a release check runs inside, and how a runner is executed there.
 *
 * Both release checks need the same three things and must not drift on any of them: a
 * throwaway directory outside the repository with the packed tarball installed into it, proof
 * that the installed bytes are that tarball's, and a runner that executes from inside the
 * project rather than from the working tree. What the runner then does — apply a migration,
 * call a provider — is the only part that differs.
 *
 * Nothing here is created inside the repository. A project under the working tree would find
 * the repository's own `node_modules` on the way up, and its resolution of `llmswitch` would
 * stop being evidence about the tarball.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { buildChildEnvironment } from './child-environment.mjs'
import { checkInstalledIsTheTarball, unpackReference } from './installed-package.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
/** The guard every runner needs, copied in beside it so it resolves from the project. */
const GUARD = join(import.meta.dirname, 'subpath-resolution.mjs')

/** Enough for any plausible run; more than this is a runaway, and a runaway is a failure. */
const OUTPUT_LIMIT = 16 * 1024 * 1024
/** An install has to fetch the peer and the driver; beyond this something is wrong. */
const INSTALL_DEADLINE = 10 * 60_000

/**
 * A version this repository pins for its own development, as an install specifier.
 *
 * The published package has no runtime dependencies, so a project that installs it still has
 * to be given the peer it declares and any driver the check needs. Those come from here rather
 * than from a second list, so a verification run exercises the same versions the package is
 * developed and tested against. A runner cannot read this itself: it runs in a project that
 * has no view of the repository's development dependencies.
 *
 * @param name The package to look up.
 * @returns `name@range`, exactly as the manifest declares it.
 * @throws `Error` when the repository does not declare it.
 */
export function pinnedDevelopmentVersion(name) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const range = manifest.devDependencies?.[name]
  if (typeof range !== 'string') {
    throw new Error(`the repository does not declare a development version of ${name}`)
  }
  return `${name}@${range}`
}

/**
 * Creates the project, installs the tarball into it, and checks that what landed is the
 * tarball's own bytes.
 *
 * @param opts `workspace` is the throwaway directory everything is created under; `name` names
 *   the project directory; `tarballPath` is the packed tarball; `packages` are further install
 *   specifiers, such as the peer dependency and a driver; `files` are copied into the project
 *   root, the runner among them.
 * @returns The project directory, the `HOME` its children are given, and the tarball's
 *   reference digest.
 * @throws `Error` when the install fails or the installed package is not the tarball.
 */
export function createConsumerProject(opts) {
  const directory = join(opts.workspace, opts.name)
  const home = join(opts.workspace, `${opts.name}-home`)
  mkdirSync(directory, { recursive: true })
  mkdirSync(home, { recursive: true })

  // Named for what it is and never `llmswitch`: a project carrying the package's own name
  // would resolve the subpaths to itself, which is the one thing the guard exists to catch.
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(
      { name: `llmswitch-${opts.name}`, version: '0.0.0', private: true, type: 'module' },
      null,
      2,
    )}\n`,
  )

  const reference = unpackReference(opts.tarballPath, join(opts.workspace, `${opts.name}-ref`))
  const install = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-save', opts.tarballPath, ...opts.packages],
    {
      cwd: directory,
      env: buildChildEnvironment(home),
      encoding: 'utf8',
      maxBuffer: OUTPUT_LIMIT,
      timeout: INSTALL_DEADLINE,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (install.status !== 0) {
    throw new Error(
      `installing the tarball failed\n${install.stdout ?? ''}${install.stderr ?? ''}`,
    )
  }

  const problems = []
  checkInstalledIsTheTarball(directory, reference, 'the scratch project', problems)
  if (problems.length > 0) throw new Error(problems.join('\n'))

  for (const file of [GUARD, ...opts.files]) {
    copyFileSync(file, join(directory, basename(file)))
  }
  return { directory, home, reference }
}

/**
 * Runs a copied runner from inside the project, under the child environment allowlist.
 *
 * `process.execPath` rather than a shell: the runner must be the same Node this check is
 * running under, and no argument may ever be interpreted by anything.
 *
 * @param project What `createConsumerProject` returned.
 * @param opts `script` is the runner's file name in the project; `args` are its arguments;
 *   `values` are further allowlisted environment names; `timeout` bounds the run.
 * @returns Whether it exited zero, and everything it printed.
 */
export function runInConsumerProject(project, opts) {
  const result = spawnSync(
    process.execPath,
    [join(project.directory, opts.script), ...opts.args],
    {
      cwd: project.directory,
      env: buildChildEnvironment(project.home, opts.values),
      encoding: 'utf8',
      maxBuffer: OUTPUT_LIMIT,
      timeout: opts.timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  // `error` covers the runner never starting, overflowing the buffer, and being stopped at
  // the deadline. Any of those means the run proved nothing, which is a failure, not a pass.
  const failure = result.error
  const note = failure === undefined ? '' : `\n${failure.message}`
  return {
    ok: failure === undefined && result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${note}`,
  }
}
