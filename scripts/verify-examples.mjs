#!/usr/bin/env node
/**
 * Runs each example under `examples/` end to end against a packed tarball, and proves the
 * answer it returns could only have come from the package that was installed.
 *
 * Every run is anchored on a nonce. The nonce goes into the request the harness posts to
 * the example, the local fixture server accepts the provider call only if it comes back
 * inside the OpenAI-format request body, and the response it serves is built from the
 * committed template with content derived from that same nonce. So a passing run means the
 * example parsed the input, routed it through the installed package, reached the provider
 * with the right model and credentials, validated the answer against its own schema, and
 * reported the route it took — a chain no cached build or stale server can fake. The
 * fixture's address reaches the example only when its server starts: the build stage is
 * given an address nothing answers on, so a value captured at build time cannot pass for a
 * value read at runtime.
 *
 * The temporary project is assembled outside the repository from an explicit list of the
 * example's tracked files, so nothing untracked — a local `.env`, an `.npmrc`, a stray
 * `node_modules` — can travel into it. The child environment is the shared allowlist, which
 * carries a synthetic key and the fixture's base URL and nothing else: no run of this can
 * become live billed traffic.
 *
 * Needs the network for `npm ci`.
 *
 * Usage: node scripts/verify-examples.mjs [path-to-tarball]
 *   With no argument, packs the working tree — including whatever `dist/` currently holds,
 *   so a stale local build is verified as it is. CI passes the audited tarball.
 * Exit codes: 0 every example ran as documented, 1 one did not, 2 bad arguments.
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { buildChildEnvironment } from './lib/child-environment.mjs'
import {
  checkInstalledIsTheTarball,
  hashFile,
  unpackReference,
} from './lib/installed-package.mjs'

const ROOT = join(import.meta.dirname, '..')
const TEMPLATE = join(import.meta.dirname, 'fixtures', 'openai-chat-completion.json')
const USAGE = 'usage: verify-examples.mjs [path-to-tarball]\n'

/** The registry `npm ci` is pinned to, as a command-line option rather than an inherited one. */
const REGISTRY = 'https://registry.npmjs.org'
/** What both examples route to, and what the fixture insists the request asks for. */
const MODEL = 'gpt-4.1-mini'
/** Not a key and not shaped like one: the fixture only checks that it arrives verbatim. */
const FIXTURE_KEY = 'fixture-credential-for-the-examples-harness'
/** How every example must declare the package, and how its lockfile must resolve it. */
const LOCAL_SPEC = 'file:./llmswitch-local.tgz'
const LOCAL_RESOLVED = 'file:llmswitch-local.tgz'

/** One per stage, so a slow install and a hung server fail as different things. */
const DEADLINES = {
  install: 6 * 60_000,
  build: 6 * 60_000,
  readiness: 120_000,
  headers: 30_000,
  body: 30_000,
  teardown: 10_000,
}
/**
 * The whole run, comfortably inside the workflow job's own timeout so this trips first and
 * says which stage was running — a bare job kill says nothing.
 */
const BUDGET = 30 * 60_000
/** How long a server gets to leave on its own after TERM before it is killed. */
const TERM_GRACE = 3_000
/** A moment for a late second provider call to land, so the accounting sees it. */
const DRAIN_GRACE = 500
/** Enough for any plausible run; more than this is a runaway, and a runaway is a failure. */
const OUTPUT_LIMIT = 8 * 1024 * 1024
/** Nothing the fixture is asked to read is anywhere near this large. */
const REQUEST_LIMIT = 1024 * 1024
/** Nor is anything an example is asked to answer with. */
const RESPONSE_LIMIT = 4 * 1024 * 1024
/** A port can be taken between being offered and being bound; three tries is plenty. */
const PORT_ATTEMPTS = 3
/** One readiness poll, and the pause between two of them. Both clamped by the stage's end. */
const POLL_DEADLINE = 5_000
const POLL_INTERVAL = 250

/**
 * @typedef {{
 *   name: string,
 *   files: string[],
 *   build: { bin: string, args: string[] } | null,
 *   route: string,
 *   health: string,
 *   start: (opts: { port: number, project: string }) => {
 *     command: string,
 *     args: string[],
 *     values: Record<string, string>,
 *   },
 * }} Example
 */

/**
 * The examples, each with the tracked files it is built from. The list is explicit and
 * compared against `git ls-files`: a new file has to be named here before it can travel
 * into a temporary project, and a deleted one fails loudly rather than silently. The set of
 * example directories is compared the same way, so a new one cannot go unverified.
 *
 * @type {Example[]}
 */
const EXAMPLES = [
  {
    name: 'express',
    files: ['README.md', 'package-lock.json', 'package.json', 'server.js', 'switch.js'],
    build: null,
    route: '/summarize',
    health: '/healthz',
    start: ({ port }) => ({
      command: process.execPath,
      args: ['server.js'],
      values: { HOST: '127.0.0.1', PORT: String(port) },
    }),
  },
  {
    name: 'next',
    files: [
      'README.md',
      'app/api/healthz/route.ts',
      'app/api/summarize/route.ts',
      'lib/switch.ts',
      'next-env.d.ts',
      'package-lock.json',
      'package.json',
      'tsconfig.json',
    ],
    build: { bin: 'next', args: ['build'] },
    route: '/api/summarize',
    health: '/api/healthz',
    start: ({ port, project }) => ({
      command: binary(project, 'next'),
      args: ['start', '-H', '127.0.0.1', '-p', String(port)],
      values: {},
    }),
  },
]

/** A binary from the temporary project's own `node_modules`, never one on the PATH. */
function binary(project, name) {
  return join(project, 'node_modules', '.bin', name)
}

/** Assembled rather than interpolated, so a URL in this file is always a readable one. */
function localUrl(port, path) {
  return 'http://127.0.0.1:' + String(port) + path
}

/** An address nothing answers on. Install and build get this; only the server gets the fixture. */
const UNREACHABLE_BASE = localUrl(1, '/v1')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/** What the run is doing right now, so the overall budget can name it if it trips. */
let stage = 'starting up'

/* ------------------------------------------------------------------ the nonce ---- */

const articleFor = (nonce) =>
  `Run ${nonce}: rooftop solar keeps climbing, and falling battery prices finally make ` +
  'home storage practical.'
const summaryFor = (nonce) => `Rooftop solar and storage, run ${nonce}.`
const keyPointFor = (nonce) => `nonce ${nonce}`

/* ---------------------------------------------------------------- the fixture ---- */

/** The committed shape, with this run's model and nonce-derived content filled in. */
function renderResponse(template, nonce) {
  const body = structuredClone(template)
  body.model = MODEL
  body.choices[0].message.content = JSON.stringify({
    summary: summaryFor(nonce),
    keyPoints: [keyPointFor(nonce)],
  })
  return JSON.stringify(body)
}

/**
 * Why a provider call is not the one this run expects, or `null` when it is. Everything is
 * checked: a request that reached the fixture by another path, with another credential, or
 * asking for another model is not evidence about this example.
 */
function describeUnexpected(request, rawBody, state) {
  if (state.accepted > 0) return 'a second provider call was made'
  if (request.method !== 'POST') return `method ${String(request.method)}`
  if (request.url !== '/v1/chat/completions') return `path ${String(request.url)}`
  if (request.headers.authorization !== `Bearer ${FIXTURE_KEY}`) return 'credential'
  if (!String(request.headers['content-type'] ?? '').includes('application/json')) {
    return 'content type'
  }
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return 'body is not JSON'
  }
  if (body?.model !== MODEL) return `model ${String(body?.model)}`
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length !== 1) return 'messages'
  const content = messages[0]?.content
  if (typeof content !== 'string') return 'message content'
  if (!content.includes(state.nonce)) return "the prompt does not carry this run's nonce"
  return null
}

/** Starts the fixture on a port of the kernel's choosing and reports which one it got. */
function startFixture(state, session) {
  return new Promise((ready, failed) => {
    const server = createServer((request, response) => {
      // Counted the moment it arrives, not when its body ends: a call that opens and never
      // finishes is still a call, and would otherwise be invisible to the accounting.
      state.received += 1
      state.active += 1
      response.on('close', () => {
        state.active -= 1
      })

      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size <= REQUEST_LIMIT) chunks.push(chunk)
      })
      request.on('end', () => {
        const problem =
          size > REQUEST_LIMIT
            ? 'the request body was too large to read'
            : describeUnexpected(request, Buffer.concat(chunks).toString('utf8'), state)
        if (problem !== null) {
          state.unexpected.push(problem)
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"unexpected request"}}')
          return
        }
        state.accepted += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(renderResponse(state.template, state.nonce))
      })
    })
    server.on('connection', (socket) => {
      session.sockets.add(socket)
      socket.on('close', () => session.sockets.delete(socket))
    })
    server.on('error', failed)
    server.listen(0, '127.0.0.1', () => {
      session.servers.add(server)
      const address = server.address()
      ready(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/* ---------------------------------------------------------------- the session ---- */

/** Every session still holding something, so a signal can give all of it back. */
const live = new Set()

function createSession() {
  const session = {
    directories: new Set(),
    children: new Set(),
    servers: new Set(),
    sockets: new Set(),
    controllers: new Set(),
    timers: new Set(),
  }
  live.add(session)
  return session
}

function killGroup(child, signal) {
  if (child.pid === undefined) return
  try {
    // The whole group: a server or a build that spawned workers must not leave them behind.
    process.kill(-child.pid, signal)
  } catch {
    // Already gone, which is the outcome being asked for.
  }
}

/**
 * Waits for `promise`, but not longer than `ms`. The timer is cleared either way: a plain
 * `Promise.race` against a `setTimeout` leaves the loser ticking, and a teardown that wins
 * its race would still hold the process open for the length of the deadline it beat.
 */
function raceAgainstTime(promise, ms) {
  let handle
  const expiry = new Promise((done) => {
    handle = setTimeout(done, ms)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(handle))
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    // The leader is gone; anything it started in the group is not.
    killGroup(child, 'SIGKILL')
    return
  }
  const exited = new Promise((done) => child.once('exit', () => done(undefined)))
  killGroup(child, 'SIGTERM')
  const kill = setTimeout(() => killGroup(child, 'SIGKILL'), TERM_GRACE)
  await raceAgainstTime(exited, DEADLINES.teardown)
  clearTimeout(kill)
  killGroup(child, 'SIGKILL')
}

async function closeServer(server, sockets) {
  const closed = new Promise((done) => server.close(() => done(undefined)))
  // Keep-alive connections would hold `close` open until they time out.
  for (const socket of sockets) {
    sockets.delete(socket)
    socket.destroy()
  }
  await raceAgainstTime(closed, DEADLINES.teardown)
}

/** Runs one cleanup step; a step that throws must not strand the ones after it. */
async function attempt(work) {
  try {
    await work()
  } catch {
    // Best effort: what is left to release still has to be released.
  }
}

/**
 * Everything of the session that runs: its timers, its outstanding requests, its children
 * and its fixture. Separated from the directories because on the emergency paths every
 * session's processes must stop before any workspace is removed from under them.
 */
async function stopProcesses(session) {
  for (const timer of session.timers) {
    session.timers.delete(timer)
    clearTimeout(timer)
  }
  for (const controller of session.controllers) {
    session.controllers.delete(controller)
    await attempt(() => controller.abort())
  }
  for (const child of session.children) {
    await attempt(() => stopChild(child))
    session.children.delete(child)
  }
  for (const server of session.servers) {
    await attempt(() => closeServer(server, session.sockets))
    session.servers.delete(server)
  }
}

/**
 * Gives back everything the session still holds: what runs first, then the directories it
 * was running in. Each entry leaves the set only once it has been dealt with, so nothing is
 * dropped half-stopped, and every step is best-effort so one failure cannot strand the rest.
 */
async function release(session) {
  await stopProcesses(session)
  for (const directory of session.directories) {
    session.directories.delete(directory)
    await attempt(() => rmSync(directory, { recursive: true, force: true }))
  }
  live.delete(session)
}

/** In flight, so a second signal joins the shutdown already running instead of racing it. */
let shuttingDown = null

/**
 * The signal, budget and uncaught paths: whatever any session still holds, wherever it is.
 * Processes are stopped across every session — newest first, so an example's server dies
 * before the workspace it lives in — and only then is anything removed from disk.
 */
function releaseAll() {
  shuttingDown ??= (async () => {
    const sessions = [...live].reverse()
    for (const session of sessions) await attempt(() => stopProcesses(session))
    for (const session of sessions) await attempt(() => release(session))
    shuttingDown = null
  })()
  return shuttingDown
}

/* ----------------------------------------------------------------- the client ---- */

/**
 * Reads the body a chunk at a time and stops at the limit. `response.text()` would buffer
 * whatever the far end decided to send, and an example that answers with a stream is a
 * failure to report, not a reason to run out of memory.
 */
async function readBounded(response) {
  const body = response.body
  if (body === null) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size > RESPONSE_LIMIT) {
      throw new RangeError(`the response body passed ${String(RESPONSE_LIMIT)} bytes`)
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/** A JSON request with its own deadline and no redirect following. */
async function requestJson(session, url, init, deadline) {
  const controller = new AbortController()
  session.controllers.add(controller)
  const timer = setTimeout(() => controller.abort(), deadline)
  session.timers.add(timer)
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
    session.timers.delete(timer)
    clearTimeout(timer)
    const bodyTimer = setTimeout(() => controller.abort(), DEADLINES.body)
    session.timers.add(bodyTimer)
    try {
      return { status: response.status, text: await readBounded(response) }
    } finally {
      session.timers.delete(bodyTimer)
      clearTimeout(bodyTimer)
    }
  } finally {
    session.timers.delete(timer)
    clearTimeout(timer)
    session.controllers.delete(controller)
  }
}

/* --------------------------------------------------------------- the children ---- */

/**
 * A bounded buffer. Once it is full it stays full: a later, smaller chunk must not slip in
 * behind one that was dropped, or what it holds reads as continuous when it is not.
 */
function createBuffer() {
  let text = ''
  let truncated = false
  return {
    append(chunk) {
      if (truncated) return
      if (text.length + chunk.length > OUTPUT_LIMIT) {
        truncated = true
        return
      }
      text += chunk
    },
    get text() {
      return text
    },
    get truncated() {
      return truncated
    },
  }
}

function spawnChild(command, args, cwd, environment, session) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    // Its own process group, so a deadline reaches whatever it started; never a shell.
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  session.children.add(child)
  const buffer = createBuffer()
  const stdout = createBuffer()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout.append(chunk)
    buffer.append(chunk)
  })
  child.stderr?.on('data', buffer.append)
  return { child, buffer, stdout }
}

/**
 * Runs a command to completion under a deadline. The deadline stops the whole process
 * group: `next build` leaves workers behind if only the process it started is signalled.
 */
async function runToCompletion(session, command, args, cwd, environment, timeout) {
  const started = spawnChild(command, args, cwd, environment, session)
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    void stopChild(started.child)
  }, timeout)
  session.timers.add(deadline)

  // `close`, not `exit`: the streams are drained by then, so what the command printed on
  // its way out — a packed filename, an EADDRINUSE — is all here rather than partly here.
  const result = await new Promise((done) => {
    started.child.once('error', (error) => done({ status: null, error }))
    started.child.once('close', (status) => done({ status, error: null }))
  })

  session.timers.delete(deadline)
  clearTimeout(deadline)
  await stopChild(started.child)
  session.children.delete(started.child)

  const note = expired ? `\nthe command was stopped after ${String(timeout)}ms` : ''
  const failure = result.error === null ? '' : `\n${result.error.message}`
  // A command that overran the buffer is a runaway, and the output it was judged on has a
  // hole in it either way. Servers are held to a softer rule: theirs is a log, not a result.
  const overran = started.buffer.truncated
    ? `\nthe command printed more than ${String(OUTPUT_LIMIT)} bytes, so its output is cut short`
    : ''
  return {
    ok: !expired && !started.buffer.truncated && result.error === null && result.status === 0,
    stdout: started.stdout.text,
    output: `${started.buffer.text}${overran}${failure}${note}`,
  }
}

/* ---------------------------------------------------------------- the project ---- */

/** Every `examples/<name>/` the repository tracks. */
function exampleDirectories() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'examples'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const names = new Set()
  for (const entry of listed.split('\0')) {
    if (entry === '') continue
    const parts = entry.split('/')
    if (parts.length >= 3 && parts[1] !== undefined) names.add(parts[1])
  }
  return [...names].sort()
}

/** The example's tracked files, relative to its own directory. */
function trackedFiles(name) {
  const prefix = `examples/${name}/`
  const listed = execFileSync('git', ['ls-files', '-z', '--', `examples/${name}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return listed
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(prefix.length))
    .sort()
}

/**
 * The one shape the tarball waiver below is safe for: the package is installed once, at the
 * root of the tree, from the local file — no workspace, no override, no second copy.
 */
function checkLockfileShape(lockfile, name, problems) {
  const packages = lockfile.packages
  if (packages === undefined || packages === null) {
    problems.push(`${name}: package-lock.json has no package tree`)
    return false
  }
  const local = packages['node_modules/llmswitch']
  if (local === undefined) {
    problems.push(`${name}: package-lock.json does not install llmswitch at the tree root`)
    return false
  }
  // Where the package comes from, not just where it lands. Dropping the checksum below is
  // only safe because the source is this file: a lockfile edited to name a registry copy
  // would have no checksum either, and would otherwise walk straight through that waiver.
  if (packages['']?.dependencies?.llmswitch !== LOCAL_SPEC) {
    problems.push(`${name}: package.json must depend on llmswitch as '${LOCAL_SPEC}'`)
    return false
  }
  if (local.resolved !== LOCAL_RESOLVED) {
    problems.push(
      `${name}: package-lock.json resolves llmswitch from ${String(local.resolved)}, ` +
        `not the packed tarball at ${LOCAL_RESOLVED}`,
    )
    return false
  }
  if (local.link === true) {
    problems.push(`${name}: package-lock.json links llmswitch rather than unpacking it`)
    return false
  }
  // The local tarball is packed fresh for every run, so no committed checksum can describe
  // it and `npm ci` refuses one that does not match. The lockfile is there for the
  // transitive tree; what was actually installed is proved a step later, against the
  // tarball itself — which only holds while nothing else can supply the package.
  if (local.integrity !== undefined) {
    problems.push(
      `${name}: package-lock.json records a checksum for llmswitch-local.tgz — ` +
        'regenerate it and drop that field, or no packed tarball but that one will install',
    )
    return false
  }
  for (const key of ['workspaces', 'overrides']) {
    if (lockfile[key] !== undefined) {
      problems.push(
        `${name}: package-lock.json declares ${key}, which this harness cannot vouch for`,
      )
      return false
    }
  }
  for (const path of Object.keys(packages)) {
    if (path !== 'node_modules/llmswitch' && path.endsWith('/llmswitch')) {
      problems.push(`${name}: package-lock.json installs a second copy of llmswitch at ${path}`)
      return false
    }
  }
  return true
}

/** Copies exactly the named files, and fails if the repository disagrees about the list. */
function assembleProject(descriptor, workspace, tarball, problems) {
  const tracked = trackedFiles(descriptor.name)
  const expected = [...descriptor.files].sort()
  if (tracked.join('\n') !== expected.join('\n')) {
    problems.push(
      `${descriptor.name}: the tracked files are not the ones this harness copies — ` +
        `tracked ${tracked.join(', ')}; expected ${expected.join(', ')}`,
    )
    return null
  }
  const project = join(workspace, descriptor.name)
  for (const file of expected) {
    const source = join(ROOT, 'examples', descriptor.name, file)
    // A symlink would be followed into the temporary project, carrying in whatever it
    // points at. Only ordinary files travel.
    if (!lstatSync(source).isFile()) {
      problems.push(`${descriptor.name}: ${file} is not a regular file`)
      return null
    }
    const target = join(project, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }

  const lockfile = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'))
  if (!checkLockfileShape(lockfile, descriptor.name, problems)) return null

  copyFileSync(tarball, join(project, 'llmswitch-local.tgz'))
  return project
}

/* ----------------------------------------------------------------- the server ---- */

/** A port nothing is listening on right now. It can still be taken before we bind it. */
function freePort() {
  return new Promise((ready, failed) => {
    const probe = createSocketServer()
    probe.on('error', failed)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => ready(port))
    })
  })
}

/**
 * Polls `/healthz` until it answers with this run's token, or gives up saying why. `until`
 * is an instant, not a duration, and it belongs to the whole readiness stage: each poll gets
 * only the time left, so retrying on a taken port cannot buy the stage another full deadline.
 */
async function waitForReadiness(session, descriptor, port, token, started, until) {
  while (Date.now() < until) {
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      return { ready: false, reason: 'the server exited before it was ready' }
    }
    const remaining = until - Date.now()
    try {
      const answer = await requestJson(
        session,
        localUrl(port, descriptor.health),
        { method: 'GET' },
        Math.min(POLL_DEADLINE, remaining),
      )
      if (answer.status === 200 && JSON.parse(answer.text)?.token === token) {
        return { ready: true, reason: '' }
      }
    } catch {
      // Not listening yet, or answering something else; either way, try again.
    }
    await delay(Math.min(POLL_INTERVAL, Math.max(0, until - Date.now())))
  }
  return { ready: false, reason: 'the server did not become ready in time' }
}

/**
 * Starts the example's server, retrying on a port that was taken between being offered and
 * being bound. Anything else is the failure it looks like.
 */
async function startExampleServer(descriptor, project, environmentFor, token, session) {
  // One deadline for the stage, shared by every attempt.
  const until = Date.now() + DEADLINES.readiness
  let last = 'the server never started'
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    if (Date.now() >= until) return { port: 0, problem: last }
    const port = await freePort()
    const spec = descriptor.start({ port, project })
    const started = spawnChild(
      spec.command,
      spec.args,
      project,
      environmentFor(spec.values),
      session,
    )
    const readiness = await waitForReadiness(session, descriptor, port, token, started, until)
    if (readiness.ready) return { port, problem: null }

    await stopChild(started.child)
    session.children.delete(started.child)
    // The log is bounded rather than fatal here, but a cut-short one is said out loud so a
    // diagnosis is never read off an incomplete record.
    const log = `${started.buffer.text}${started.buffer.truncated ? '\nthe server printed more than the harness kept, so this log is cut short' : ''}`
    if (started.buffer.text.includes('EADDRINUSE')) {
      last = 'every attempted port was already in use'
      continue
    }
    return { port, problem: `${readiness.reason}\n${log}` }
  }
  return { port: 0, problem: last }
}

/* ---------------------------------------------------------------- one example ---- */

/** Everything the answer has to satisfy for the run to have proved anything. */
function checkAnswer(answer, nonce, problems) {
  if (answer.status !== 200) {
    problems.push(`the example answered ${String(answer.status)}, not 200: ${answer.text}`)
    return
  }
  let body
  try {
    body = JSON.parse(answer.text)
  } catch {
    problems.push('the example did not answer with JSON')
    return
  }
  if (body?.data?.summary !== summaryFor(nonce)) {
    problems.push("the summary is not the fixture's nonce-derived one")
  }
  const keyPoints = body?.data?.keyPoints
  if (
    !Array.isArray(keyPoints) ||
    keyPoints.length !== 1 ||
    keyPoints[0] !== keyPointFor(nonce)
  ) {
    problems.push("the key points are not the fixture's nonce-derived ones")
  }
  if (body?.provider !== 'openai')
    problems.push(`it reports provider ${String(body?.provider)}`)
  if (body?.model !== MODEL) problems.push(`it reports model ${String(body?.model)}`)
  if (body?.usedFallback !== false) problems.push('it did not answer on the primary route')
}

async function verifyExample(descriptor, workspace, tarball, reference, template, problems) {
  const session = createSession()
  const nonce = randomBytes(12).toString('hex')
  const token = randomBytes(12).toString('hex')
  const state = { nonce, template, received: 0, accepted: 0, active: 0, unexpected: [] }
  stage = `${descriptor.name}: assembling the temporary project`

  try {
    const project = assembleProject(descriptor, workspace, tarball, problems)
    if (project === null) return
    const home = join(workspace, `${descriptor.name}-home`)
    mkdirSync(home, { recursive: true })
    session.directories.add(home)

    const fixturePort = await startFixture(state, session)
    /**
     * The fixture-controlled names are fixed here; an example may add only the rest. An
     * overlap would let the example choose the address its own provider call goes to.
     */
    const environmentFor = (values, baseUrl) => {
      const fixed = {
        OPENAI_API_KEY: FIXTURE_KEY,
        OPENAI_BASE_URL: baseUrl,
        EXAMPLE_READY_TOKEN: token,
      }
      for (const name of Object.keys(values)) {
        if (name in fixed) throw new RangeError(`the example may not set ${name}`)
      }
      return buildChildEnvironment(home, { ...fixed, ...values })
    }

    stage = `${descriptor.name}: installing the packed tarball`
    const userconfig = join(workspace, `${descriptor.name}.npmrc`)
    writeFileSync(userconfig, '')
    const install = await runToCompletion(
      session,
      'npm',
      ['ci', '--ignore-scripts', '--userconfig', userconfig, '--registry', REGISTRY],
      project,
      environmentFor({}, UNREACHABLE_BASE),
      DEADLINES.install,
    )
    if (!install.ok) {
      problems.push(`${stage} failed\n${install.output}`)
      return
    }

    stage = `${descriptor.name}: checking the installed bytes`
    const installed = []
    checkInstalledIsTheTarball(project, reference, descriptor.name, installed)
    if (installed.length > 0) {
      problems.push(...installed)
      return
    }

    if (descriptor.build !== null) {
      stage = `${descriptor.name}: building`
      const build = await runToCompletion(
        session,
        binary(project, descriptor.build.bin),
        descriptor.build.args,
        project,
        environmentFor({}, UNREACHABLE_BASE),
        DEADLINES.build,
      )
      if (!build.ok) {
        problems.push(`${stage} failed\n${build.output}`)
        return
      }
    }

    stage = `${descriptor.name}: starting the server and waiting for readiness`
    const fixtureBase = localUrl(fixturePort, '/v1')
    const server = await startExampleServer(
      descriptor,
      project,
      (values) => environmentFor(values, fixtureBase),
      token,
      session,
    )
    if (server.problem !== null) {
      problems.push(`${stage} failed — ${server.problem}`)
      return
    }

    stage = `${descriptor.name}: requesting the operation`
    const answer = await requestJson(
      session,
      localUrl(server.port, descriptor.route),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: articleFor(nonce) }),
      },
      DEADLINES.headers,
    )

    stage = `${descriptor.name}: checking what came back`
    // A late second call would otherwise be torn down before it was counted.
    await delay(DRAIN_GRACE)
    const found = []
    checkAnswer(answer, nonce, found)
    if (state.received !== 1 || state.accepted !== 1) {
      found.push(
        `the fixture saw ${String(state.received)} provider call(s) and accepted ` +
          `${String(state.accepted)}; exactly one of each was expected`,
      )
    }
    // After the drain, nothing may still be in flight — otherwise the counts above are a
    // snapshot of a conversation that had not finished.
    if (state.active !== 0) {
      found.push(
        `${String(state.active)} provider call(s) were still open when the run was counted`,
      )
    }
    for (const unexpected of state.unexpected) {
      found.push(`the fixture refused a provider call: ${unexpected}`)
    }
    for (const problem of found) problems.push(`${descriptor.name}: ${problem}`)
  } catch (error) {
    problems.push(
      `${stage} failed — ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    stage = `${descriptor.name}: tearing down`
    await release(session)
  }
}

/* ----------------------------------------------------------------------- main ---- */

const shutdown = createSession()

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length > 1) {
    process.stderr.write(USAGE)
    return 2
  }

  let tarball = argv[0]
  if (tarball !== undefined) {
    if (!isAbsolute(tarball)) tarball = resolve(tarball)
    let file = null
    try {
      file = statSync(tarball)
    } catch {
      // reported below
    }
    if (file === null || !file.isFile()) {
      process.stderr.write(`'${tarball}' is not an existing tarball file\n${USAGE}`)
      return 2
    }
  }

  const workspace = mkdtempSync(join(tmpdir(), 'llmswitch-examples-'))
  shutdown.directories.add(workspace)
  const problems = []
  try {
    stage = 'reading the fixture template'
    let template
    try {
      template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
    } catch (error) {
      process.stderr.write(
        `${stage} failed — ${error instanceof Error ? error.message : 'unknown error'}\n`,
      )
      return 1
    }

    stage = 'reading the tracked examples'
    const directories = exampleDirectories()
    const named = EXAMPLES.map((descriptor) => descriptor.name).sort()
    if (directories.join(', ') !== named.join(', ')) {
      process.stderr.write(
        `${stage} failed — the repository tracks examples/${directories.join(', examples/')}, ` +
          `but this harness verifies ${named.join(', ')}\n`,
      )
      return 1
    }

    if (tarball === undefined) {
      stage = 'packing the working tree'
      const home = join(workspace, 'pack-home')
      mkdirSync(home)
      const packed = await runToCompletion(
        shutdown,
        'npm',
        ['pack', '--json', '--pack-destination', workspace],
        ROOT,
        buildChildEnvironment(home),
        DEADLINES.install,
      )
      if (!packed.ok) {
        process.stderr.write(`${stage} failed\n${packed.output}`)
        return 1
      }
      tarball = join(workspace, JSON.parse(packed.stdout)[0].filename)
    }

    stage = 'unpacking the tarball to compare against'
    const before = hashFile(tarball)
    const reference = unpackReference(tarball, workspace)
    for (const descriptor of EXAMPLES) {
      await verifyExample(descriptor, workspace, tarball, reference, template, problems)
    }
    stage = 'rechecking the tarball'
    if (hashFile(tarball) !== before) {
      problems.push('the tarball changed while the examples were being run')
    }
  } finally {
    stage = 'tearing down'
    await releaseAll()
  }

  for (const problem of problems) process.stdout.write(`${problem}\n`)
  process.stdout.write(
    problems.length === 0
      ? `all ${String(EXAMPLES.length)} examples installed the packed tarball, reached the ` +
          `fixture provider once with the expected model and credential, and returned the ` +
          `run's nonce back through their own output schema on the primary route\n`
      : `${String(problems.length)} problem(s)\n`,
  )
  return problems.length === 0 ? 0 : 1
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void releaseAll().finally(() => process.exit(1))
  })
}
process.on('uncaughtException', (error) => {
  process.stderr.write(`${String(error)}\n`)
  void releaseAll().finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${String(reason)}\n`)
  void releaseAll().finally(() => process.exit(1))
})

const budget = setTimeout(() => {
  process.stderr.write(
    `the run exceeded its ${String(BUDGET / 60_000)}-minute budget while ${stage}\n`,
  )
  void releaseAll().finally(() => process.exit(1))
}, BUDGET)
shutdown.timers.add(budget)

process.exitCode = await main()
clearTimeout(budget)
