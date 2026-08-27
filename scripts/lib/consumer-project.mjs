/**
 * The scratch project a release check installs a tarball into, and how a runner is executed
 * there.
 *
 * Projects are always created outside the repository: one under the working tree would find
 * the repository's own `node_modules` on the way up, and its resolution of `llmdispatch` would
 * stop being evidence about the tarball.
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { buildChildEnvironment } from './child-environment.mjs'
import { checkInstalledIsTheTarball, unpackReference } from './installed-package.mjs'
import { createSecretFilter } from './secret-filter.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
/** The guard every runner needs, copied in beside it so it resolves from the project. */
const GUARD = join(import.meta.dirname, 'subpath-resolution.mjs')

/** Enough for any plausible run; more than this is a runaway, and a runaway is a failure. */
const OUTPUT_LIMIT = 16 * 1024 * 1024
/** An install has to fetch the peer and the driver; beyond this something is wrong. */
const INSTALL_DEADLINE = 10 * 60_000

/**
 * The lockfile entry a package at `fromPath` would reach by importing `name`, following Node
 * resolution up the `node_modules` chain.
 *
 * @param lock The parsed `package-lock.json`.
 * @param fromPath The lockfile key of the package doing the importing, `''` for the root.
 * @param name The package being imported.
 * @returns `{ path, entry }` for the entry that would be reached, or `null` when none is.
 */
function resolveFromLock(lock, fromPath, name) {
  const segments = fromPath === '' ? [] : fromPath.split('/')
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join('/')
    const path = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`
    const entry = lock.packages?.[path]
    if (entry !== undefined) return { path, entry }
  }
  return null
}

/**
 * The exact version this repository has installed, as an install specifier.
 *
 * From the lockfile rather than the manifest's range, so the scratch project installs the
 * version this repository is developed against instead of whatever the registry serves today.
 *
 * @param name The package to look up.
 * @returns `name@version`.
 * @throws `Error` when the repository does not declare it or the lockfile does not record it.
 */
export function pinnedDevelopmentVersion(name) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.devDependencies?.[name] !== 'string') {
    throw new Error(`the repository does not declare a development version of ${name}`)
  }
  const found = resolveFromLock(readLockfile(), '', name)
  if (found === null || typeof found.entry.version !== 'string') {
    throw new Error(
      `package-lock.json records no installed version of ${name}, run \`npm install\``,
    )
  }
  return `${name}@${found.entry.version}`
}

/** The repository's lockfile, parsed. */
function readLockfile() {
  return JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
}

/**
 * Exact versions for the transitive closure of the named packages, as npm `overrides`.
 *
 * Pinning the roots alone leaves their own dependencies: `pg-pool`, `pg-protocol` and the
 * rest: resolving from the registry at install time, so the check would be unreproducible in
 * the part of it nobody looks at. Overrides pin every nested resolution without adding
 * anything to the dependency list: an optional dependency stays optional, so a platform that
 * cannot install `pg-cloudflare` is not made to.
 *
 * @param names The packages whose closure to pin, each of which the repository must declare.
 * @returns A map of package name to exact version, for the project's `overrides` field.
 * @throws `Error` when a package is not declared or recorded, when a required dependency
 * cannot be resolved, or when two nodes reach the same name at different versions: that has
 * no single answer, so it is refused rather than decided quietly.
 */
export function pinnedDevelopmentOverrides(names) {
  const lock = readLockfile()
  const pinned = new Map()
  const queue = []
  for (const name of names) {
    pinnedDevelopmentVersion(name)
    const found = resolveFromLock(lock, '', name)
    if (found !== null) queue.push(found)
  }

  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const { path, entry } = next
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const already = pinned.get(name)
    if (already !== undefined) {
      if (already !== entry.version) {
        throw new Error(
          `package-lock.json has ${name} at both ${already} and ${String(entry.version)}; ` +
            'a single override cannot express that',
        )
      }
      continue
    }
    pinned.set(name, entry.version)

    // Optional dependencies are followed only when the lockfile has them. Peer dependencies
    // are left to npm.
    for (const [dependency, optional] of [
      [entry.dependencies, false],
      [entry.optionalDependencies, true],
    ]) {
      for (const wanted of Object.keys(dependency ?? {})) {
        const found = resolveFromLock(lock, path, wanted)
        if (found === null || typeof found.entry.version !== 'string') {
          if (optional) continue
          throw new Error(
            `package-lock.json does not resolve ${wanted}, required by ${name}: ` +
              'run `npm install`',
          )
        }
        queue.push(found)
      }
    }
  }

  return Object.fromEntries([...pinned].sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * Creates the project, installs the tarball into it, and checks that what landed is the
 * tarball's own bytes.
 *
 * @param opts `workspace` is the throwaway directory everything is created under; `name` names
 *   the project directory; `tarballPath` is the packed tarball; `packages` are further install
 *   specifiers, such as the peer dependency and a driver; `overrides` pin nested resolutions;
 *   `files` are copied into the project root, the runner among them.
 * @returns The project directory, the `HOME` its children are given, and the tarball's
 *   reference digest.
 * @throws `Error` when the install fails or the installed package is not the tarball.
 */
export function createConsumerProject(opts) {
  const directory = join(opts.workspace, opts.name)
  const home = join(opts.workspace, `${opts.name}-home`)
  mkdirSync(directory, { recursive: true })
  mkdirSync(home, { recursive: true })

  // Named for what it is and never `llmdispatch`: a project carrying the package's own name
  // would resolve the subpaths to itself, which is the one thing the guard exists to catch.
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: `llmdispatch-${opts.name}`,
        version: '0.0.0',
        private: true,
        type: 'module',
        overrides: opts.overrides ?? {},
      },
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
  if (install.status !== 0 || install.error !== undefined) {
    // `error` is set when npm never started, overran the output limit or hit the deadline,
    // cases that often produce no output at all.
    const reason = install.error === undefined ? '' : `\n${install.error.message}`
    throw new Error(
      `installing the tarball failed${reason}\n${install.stdout ?? ''}${install.stderr ?? ''}`,
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
 * `process.execPath` rather than a shell, so the runner is the same Node and no argument is
 * ever interpreted.
 *
 * @param project What `createConsumerProject` returned.
 * @param opts `script` is the runner's file name in the project; `args` are its arguments;
 *   `values` are further allowlisted environment names; `timeout` bounds the run; `redact`
 *   are values to keep out of the child's output.
 * @returns A promise for whether it exited zero, and a note about how it ended when it did not.
 */
export function runInConsumerProject(project, opts) {
  return runChild({
    command: process.execPath,
    args: [join(project.directory, opts.script), ...opts.args],
    cwd: project.directory,
    env: buildChildEnvironment(project.home, opts.values),
    timeout: opts.timeout,
    redact: opts.redact ?? [],
  })
}

/**
 * Spawns a child, streams its output through this process's, and waits for it to end.
 *
 * Asynchronous because `spawnSync` blocks the event loop, which would leave signals sent to
 * this process undispatched until the child had finished on its own. Output is streamed so a
 * long or killed run is still watchable, and passes through `createSecretFilter` on the way.
 *
 * @param opts `command`, `args`, `cwd`, `env` and `timeout` are the spawn; `redact` are values
 *   to remove from the child's output on the way through.
 * @returns A promise for whether it exited zero, and a note about how it ended when it did not.
 */
export function runChild(opts) {
  // Once a signal has been handled, nothing new starts: a caller looping over children would
  // otherwise spawn the next one while the handler was tidying up for exit.
  if (stopping) return Promise.resolve({ ok: false, note: 'not started; the run was stopped' })
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Piped rather than pumped by hand: `.pipe` propagates backpressure, so a child that
    // outruns the terminal is paused instead of buffering without limit. `end: false` keeps
    // this process's own streams open for the next child.
    child.stdout.pipe(createSecretFilter(opts.redact)).pipe(process.stdout, { end: false })
    child.stderr.pipe(createSecretFilter(opts.redact)).pipe(process.stderr, { end: false })

    // A child past its deadline has already failed, and may still hold a credential.
    let expired = false
    const deadline = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
    }, opts.timeout)

    let failure
    child.on('error', (error) => {
      failure = error
    })

    const closed = new Promise((done) => {
      child.on('close', (status, signal) => {
        clearTimeout(deadline)
        running.delete(child)
        done(undefined)
        if (expired) {
          resolve({ ok: false, note: `stopped after ${String(opts.timeout)}ms` })
          return
        }
        resolve(describeRun({ error: failure, status, signal }))
      })
    })
    running.set(child, closed)
  })
}

/**
 * The children this process has running, so a signal handler can reach them.
 *
 * @type {Map<import('node:child_process').ChildProcess, Promise<undefined>>}
 */
const running = new Map()

/** How long a child gets to stop on its own before it is killed outright. */
const STOP_GRACE = 5_000

/** Set once the run is being stopped, so no further child is spawned. */
let stopping = false

/**
 * Kills every running child and waits for it to go.
 *
 * A signal sent to this process is not delivered to a child it spawned, so without this a
 * handler would tidy up and exit while a keyed runner carried on orphaned: still holding a
 * credential, still writing to a schema that had just been dropped. Every signal handler must
 * await this before cleaning up anything else.
 *
 * @returns A promise that settles once no child is left running.
 */
export async function stopRunningChildren() {
  stopping = true
  const active = [...running.entries()]
  if (active.length === 0) return
  for (const [child] of active) child.kill('SIGTERM')

  const allClosed = Promise.all(active.map(([, closed]) => closed))
  let grace
  const expiry = new Promise((wake) => {
    grace = setTimeout(wake, STOP_GRACE)
  })
  await Promise.race([allClosed, expiry])
  clearTimeout(grace)

  // Whatever ignored SIGTERM does not get to outlive this process.
  for (const [child] of active) if (running.has(child)) child.kill('SIGKILL')
  await allClosed
}

/**
 * How a spawned check ended. A spawn error or a killing signal means the run proved nothing,
 * which is a failure rather than a pass.
 *
 * @param result The spawn's outcome: `error`, `status` and `signal`.
 * @returns Whether it exited zero, and a note about how it ended when it did not.
 */
export function describeRun(result) {
  const failure = result.error
  if (failure !== undefined) return { ok: false, note: failure.message }
  if (result.signal !== null && result.signal !== undefined) {
    return { ok: false, note: `stopped by ${result.signal}` }
  }
  return { ok: result.status === 0, note: '' }
}
