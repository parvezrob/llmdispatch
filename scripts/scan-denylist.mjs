#!/usr/bin/env node
/**
 * Scans a tree for things that should never reach a published commit or a published
 * tarball: contact addresses, links to hosts nobody has reviewed, leftover work
 * markers, commit trailers, and key-shaped strings.
 *
 * Usage:
 *   node scripts/scan-denylist.mjs [dir]   scan a directory (default: the current one)
 *   node scripts/scan-denylist.mjs --self-test
 *
 * Exit codes: 0 nothing found, 1 findings reported, 2 wrong usage or an internal error.
 *
 * Two design choices are worth knowing before you edit this file:
 *
 * 1. Findings print as `rule-id path:line` and never as the matched text. A scanner
 *    that echoes what it found turns a public build log into the leak it was meant to
 *    prevent.
 * 2. Every pattern is assembled with `new RegExp()` from fragments that do not match on
 *    their own, so this file does not contain the strings it looks for. That is what
 *    lets it scan itself: nothing here is excluded from the walk, including this script
 *    and the fixtures next to it.
 *
 * The self-test writes one deliberately matching input per rule, plus the near-misses
 * that must stay silent, into a temporary directory it deletes afterwards. Those inputs
 * are assembled at run time from harmless pieces and are never committed in any
 * encoding — a committed one would fail every ordinary run of this script and of the
 * secret scanner that runs beside it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'

const HERE = import.meta.dirname
const SELF = join(HERE, 'scan-denylist.mjs')
const ALLOWLIST_FILE = join(HERE, 'scan-allowlist.txt')
const GITLEAKS_WRAPPER = join(HERE, 'gitleaks-scan.sh')
/** Enough for any plausible run; more than this is a runaway, and a runaway is a failure. */
const OUTPUT_LIMIT = 32 * 1024 * 1024
const LOCKFILE_NAME = 'package-lock.json'
const PACKAGE_REGISTRY_HOST = 'registry.npmjs.org'
const BINARY_SNIFF_BYTES = 8192

/** Addresses that are allowed to appear verbatim. */
const ALLOWED_ADDRESSES = new Set(['48731060+parvezrob@users.noreply.github.com'])
/** Any address in this domain is a documentation placeholder by convention (RFC 2606). */
const PLACEHOLDER_DOMAIN = 'exam' + 'ple.com'
/** Repositories we link to on purpose: this one, and the tools the workflows pin. */
const ALLOWED_REPOSITORIES = new Set([
  'parvezrob/llmswitch',
  'gitleaks/gitleaks',
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'actions/download-artifact',
])

/** Builds a case-insensitive global pattern out of pieces that do not match on their own. */
function pattern(...pieces) {
  return new RegExp(pieces.join(''), 'gi')
}

/**
 * A whole link, up to the first character that cannot be part of one. Prose and markdown
 * put brackets and quotes right after a link, so those end the token rather than joining
 * it; trailing sentence punctuation is trimmed when the token is parsed.
 */
const LINK_TOKEN = pattern('ht', 'tps?:', '\\/\\/', '[^\\s<>"\'`)\\]}]+')

/** Parses a matched link, or returns null when it turns out not to be one. */
function parseLink(token) {
  const trimmed = token.replace(/[.,;:!?]+$/, '')
  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

/**
 * Rules applied line by line to the text of every non-binary file.
 * `allow` receives the whole match and its capture groups and returns true to stay silent.
 */
const CONTENT_RULES = [
  {
    id: 'address',
    pattern: pattern('[a-z0-9._%+-]+', '@', '[a-z0-9.-]+', '\\.', '[a-z]{2,}'),
    allow: (match) => {
      const address = match[0].toLowerCase()
      return ALLOWED_ADDRESSES.has(address) || address.endsWith('@' + PLACEHOLDER_DOMAIN)
    },
  },
  {
    // The host is whatever a URL parser says it is, never whatever comes after the
    // slashes: `//allowed.host:@somewhere.else/` reads as the allowlisted name to a
    // regular expression and resolves to a different machine.
    id: 'unreviewed-host',
    pattern: LINK_TOKEN,
    skipInLockfile: true,
    allow: (match, allowedHosts) => {
      const link = parseLink(match[0])
      return link !== null && allowedHosts.has(link.hostname.toLowerCase())
    },
  },
  {
    // Credentials in a link are never right, whichever host they point at. A token that
    // does not parse is left to the host rule above, which already fails closed on it.
    id: 'credentials-in-link',
    pattern: LINK_TOKEN,
    skipInLockfile: true,
    allow: (match) => {
      const link = parseLink(match[0])
      return link === null || (link.username === '' && link.password === '')
    },
  },
  {
    id: 'unreviewed-repository',
    pattern: pattern('git', 'hub', '\\.com\\/', '([a-z0-9._-]+)', '\\/', '([a-z0-9._-]+)'),
    skipInLockfile: true,
    allow: (match) => {
      const repository = `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase()
      return ALLOWED_REPOSITORIES.has(repository)
    },
  },
  {
    // All three spellings of an aliased module: the `from` form, a bare side-effect
    // import, and a dynamic one. An alias only means something to a bundler, so a
    // published package must never contain one.
    id: 'path-alias',
    pattern: pattern('(?:from|import|require)\\s*\\(?\\s*', '[\'"`]', '[@~]', '\\/'),
  },
  {
    id: 'leftover-marker',
    pattern: pattern('\\b(?:', 'TO' + 'DO', '|', 'FIX' + 'ME', '|', 'X' + 'XX', ')\\b'),
  },
  {
    id: 'commit-trailer',
    pattern: pattern(
      '\\b(?:',
      'Co-auth' + 'ored-by',
      '|',
      'Signed-' + 'off-by',
      '|',
      'Gener' + 'ated with',
      ')\\b',
    ),
  },
  {
    id: 'key-shape',
    pattern: pattern(
      '(?:-----BE',
      'GIN[ A-Z]*PRIVATE KE',
      'Y-----',
      '|\\b',
      'e' + 'y',
      '[a-z0-9_-]{10,}\\.',
      '[a-z0-9_-]{10,}\\.',
      '[a-z0-9_-]{10,})',
    ),
  },
]

/**
 * Rules applied to the path of every entry, whatever its contents. The names below are
 * the ones tools invent for local settings: `.env` and anything suffixed after it,
 * `.envrc`, and the `env.local` spellings some frameworks prefer.
 */
const ENV = 'env'
const ENVIRONMENT_FILE = new RegExp(
  `^(\\.${ENV}rc|\\.${ENV}(\\..+)?|${ENV}\\.local|.+\\.${ENV}\\.local)$`,
  'i',
)

const PATH_RULES = [
  {
    id: 'environment-file',
    matches: (path) => ENVIRONMENT_FILE.test(basename(path)),
  },
]

function readAllowedHosts() {
  const lines = readFileSync(ALLOWLIST_FILE, 'utf8').split('\n')
  const hosts = new Set()
  for (const line of lines) {
    const host = line.replace(/#.*$/, '').trim().toLowerCase()
    if (host !== '') hosts.add(host)
  }
  return hosts
}

/** Tracked files if `dir` is a checkout, every file otherwise (an unpacked tarball). */
function listFiles(dir) {
  if (existsSync(join(dir, '.git'))) {
    const output = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' })
    return output.split('\0').filter((entry) => entry !== '')
  }
  const found = []
  walk(dir, '', found)
  return found.sort()
}

function walk(root, prefix, found) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) walk(root, path, found)
    else found.push(path)
  }
}

/** True when the first bytes contain a NUL, which no text file we ship does. */
function looksBinary(absolutePath) {
  const handle = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const read = readSync(handle, buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, read).includes(0)
  } finally {
    closeSync(handle)
  }
}

/** Every `resolved` value anywhere under a lockfile node, however deeply nested. */
function collectResolved(node, found) {
  if (node === null || typeof node !== 'object') return found
  for (const [key, value] of Object.entries(node)) {
    if (key === 'resolved' && typeof value === 'string' && value !== '') found.push(value)
    else if (typeof value === 'object') collectResolved(value, found)
  }
  return found
}

/**
 * The lockfile carries funding and homepage links for every dependency, so the host
 * rule would drown in noise. What matters there is where the bytes come from, so it is
 * parsed instead and only its `resolved` fields are checked.
 *
 * Both layouts are read: `packages` as written by current npm, and the older nested
 * `dependencies` tree, whose entries nest arbitrarily deep.
 */
function scanLockfile(path, text, findings) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    findings.push({ id: 'unreadable-lockfile', path, line: 1 })
    return
  }
  // Neither layout means this is not a lockfile shape the rule can vouch for.
  if (parsed?.packages === undefined && parsed?.dependencies === undefined) {
    findings.push({ id: 'unreadable-lockfile', path, line: 1 })
    return
  }

  const lines = text.split('\n')
  const resolvedValues = [
    ...collectResolved(parsed.packages ?? {}, []),
    ...collectResolved(parsed.dependencies ?? {}, []),
  ]
  for (const resolved of resolvedValues) {
    let host
    try {
      host = new URL(resolved).hostname.toLowerCase()
    } catch {
      host = ''
    }
    if (host === PACKAGE_REGISTRY_HOST) continue
    const line = lines.findIndex((candidate) => candidate.includes(resolved)) + 1
    findings.push({ id: 'foreign-registry', path, line: line === 0 ? 1 : line })
  }
}

function scanText(path, text, allowedHosts, findings) {
  const lines = text.split('\n')
  const isLockfile = basename(path) === LOCKFILE_NAME
  for (const rule of CONTENT_RULES) {
    if (isLockfile && rule.skipInLockfile === true) continue
    for (const [index, line] of lines.entries()) {
      rule.pattern.lastIndex = 0
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.allow?.(match, allowedHosts) === true) continue
        findings.push({ id: rule.id, path, line: index + 1 })
      }
    }
  }
  if (isLockfile) scanLockfile(path, text, findings)
}

/** Scans one directory and returns every finding, without printing anything. */
function scanDirectory(dir) {
  const allowedHosts = readAllowedHosts()
  const findings = []
  for (const path of listFiles(dir)) {
    const absolutePath = join(dir, path)
    for (const rule of PATH_RULES) {
      if (rule.matches(path)) findings.push({ id: rule.id, path, line: 0 })
    }
    // A symlink is a finding, never something to follow: git stores the target string,
    // which is itself a path that may say more than it should.
    if (lstatSync(absolutePath).isSymbolicLink()) {
      findings.push({ id: 'symlink', path, line: 0 })
      continue
    }
    // A file this cannot read as text is reported rather than passed over, so nothing
    // reaches a published tree unexamined just by containing a NUL byte.
    if (looksBinary(absolutePath)) {
      findings.push({ id: 'binary', path, line: 0 })
      continue
    }
    scanText(path, readFileSync(absolutePath, 'utf8'), allowedHosts, findings)
  }
  return findings
}

function report(findings) {
  for (const finding of findings) {
    process.stdout.write(`${finding.id} ${finding.path}:${String(finding.line)}\n`)
  }
  process.stdout.write(
    findings.length === 0 ? 'clean\n' : `${String(findings.length)} finding(s)\n`,
  )
}

/* ------------------------------------------------------------------ self-test ---- */

/**
 * Every canary is assembled here from pieces that match nothing on their own, written
 * to a temporary directory, and deleted at the end. `text` is what must never appear in
 * any output; `expect` is the rule that must fire and the file it must fire on.
 */
function buildCanaries(root) {
  const canaries = []
  const write = (relativePath, contents, id) => {
    const absolutePath = join(root, relativePath)
    mkdirSync(join(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, contents)
    canaries.push({ id, path: relativePath, text: contents.trim() })
  }

  write('address.txt', 'contact ' + 'someone' + '@' + 'contoso' + '.net' + '\n', 'address')
  write('host.md', 'see ' + 'ht' + 'tps://' + 'unlisted.invalid' + '/page\n', 'unreviewed-host')
  // Nested, so that a finding here also proves the walk descends.
  write(
    'nested/deep/repo.md',
    'see ' + 'ht' + 'tps://' + 'git' + 'hub' + '.com/someone/elsewhere' + '\n',
    'unreviewed-repository',
  )
  write('alias.ts', 'import thing from ' + "'" + '@' + '/lib/thing' + "'" + '\n', 'path-alias')
  write('alias-bare.ts', 'import ' + "'" + '@' + '/side/effect' + "'" + '\n', 'path-alias')
  write('alias-dynamic.ts', 'await import(' + "'" + '~' + '/lazy' + "'" + ')\n', 'path-alias')
  write(
    'credentials.md',
    'see ' + 'ht' + 'tps://' + 'reader:secret@' + 'nodejs.org' + '/x\n',
    'credentials-in-link',
  )
  write(
    'userinfo-trick.md',
    'see ' + 'ht' + 'tps://' + 'nodejs.org' + ':@' + 'private.invalid' + '/x\n',
    'unreviewed-host',
  )
  write('ip-literal.md', 'see ' + 'ht' + 'tps://' + '203.0.113.7' + '/x\n', 'unreviewed-host')
  // The bracketed form ends at the closing bracket, so the token does not parse as a
  // link at all — which the host rule treats as unreviewed, exactly as it should.
  write(
    'ipv6-literal.md',
    'see ' + 'ht' + 'tps://' + '[2001:db8::1]' + '/x\n',
    'unreviewed-host',
  )
  write('marker.ts', '// ' + 'TO' + 'DO' + ': finish this\n', 'leftover-marker')
  write('trailer.txt', 'Co-auth' + 'ored-by: A Person\n', 'commit-trailer')
  write('key.pem', '-----BE' + 'GIN PRIVATE KE' + 'Y-----\n', 'key-shape')
  write('.' + ENV + '.local', 'SETTING=1\n', 'environment-file')
  write('.' + ENV + 'rc', 'export SETTING=1\n', 'environment-file')
  write('settings.' + ENV + '.local', 'SETTING=1\n', 'environment-file')
  write(
    'nested-lock/' + LOCKFILE_NAME,
    JSON.stringify(
      {
        lockfileVersion: 1,
        dependencies: {
          outer: {
            version: '1.0.0',
            dependencies: {
              inner: { resolved: 'ht' + 'tps://deep-mirror.invalid/i.tgz' },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
    'foreign-registry',
  )
  write(
    'odd-lock/' + LOCKFILE_NAME,
    JSON.stringify({ lockfileVersion: 3, note: 'no package tree at all' }, null, 2) + '\n',
    'unreadable-lockfile',
  )
  write(
    'lock/' + LOCKFILE_NAME,
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: { 'node_modules/thing': { resolved: 'ht' + 'tps://mirror.invalid/t.tgz' } },
      },
      null,
      2,
    ) + '\n',
    'foreign-registry',
  )
  return canaries
}

/** Inputs that look close enough to a canary to be worth proving silent. */
function buildNearMisses(root) {
  const write = (relativePath, contents) => {
    const absolutePath = join(root, relativePath)
    mkdirSync(join(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, contents)
  }

  write('ok-address.md', 'write to ' + 'reader' + '@' + PLACEHOLDER_DOMAIN + '\n')
  write('ok-author.md', [...ALLOWED_ADDRESSES][0] + '\n')
  write('ok-host.md', 'see ' + 'ht' + 'tps://' + 'nodejs.org' + '/en/download\n')
  write(
    'ok-host-port.md',
    'see ' + 'ht' + 'tps://' + 'nodejs.org' + ':8443/en/download?q=1#top\n',
  )
  write(
    'ok-repo.md',
    'see ' + 'ht' + 'tps://' + 'git' + 'hub' + '.com/parvezrob/llmswitch' + '\n',
  )
  write('ok-import.ts', "import thing from './thing.js'\n")
  write(
    'ok-lock/' + LOCKFILE_NAME,
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/thing': {
            resolved: 'ht' + 'tps://' + PACKAGE_REGISTRY_HOST + '/thing/-/thing-1.0.0.tgz',
            funding: { url: 'ht' + 'tps://' + 'sponsors.invalid' + '/thing' },
            homepage: 'ht' + 'tps://' + 'thing.invalid',
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
}

/**
 * A file whose bytes contain a canary but also a NUL. Its contents must never be read as
 * text, and its path must still be reported: unreadable is not the same as clean.
 */
function buildBinaryDecoy(root) {
  const text = 'someone' + '@' + 'contoso' + '.net'
  writeFileSync(
    join(root, 'decoy.bin'),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(text)]),
  )
  return text
}

/**
 * Runs the secret scanner over the canary directory through the same wrapper the
 * workflow uses, so the two cannot drift apart. A missing scanner is reported, not
 * silently passed.
 */
function runSecretScanner(root, canaryText) {
  writeFileSync(join(root, 'cloud-key.txt'), `key = ${canaryText}\n`)
  const result = spawnSync('sh', [GITLEAKS_WRAPPER, 'dir', root], {
    encoding: 'utf8',
    maxBuffer: OUTPUT_LIMIT,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error !== undefined) return { skipped: false, output, status: -1 }
  return { skipped: result.status === 127, output, status: result.status ?? -1 }
}

/** Runs this script the way anyone else runs it: as a command, and reads what it printed. */
function runScannerCommand(dir) {
  const result = spawnSync(process.execPath, [SELF, dir], {
    encoding: 'utf8',
    maxBuffer: OUTPUT_LIMIT,
  })
  return {
    status: result.error === undefined ? (result.status ?? -1) : -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** One reported line: a rule name, a path, and a line number. Never the match itself. */
const FINDING_LINE = /^([a-z-]+) (\S+):(\d+)$/

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'denylist-selftest-'))
  const problems = []
  try {
    const canaries = buildCanaries(root)
    buildNearMisses(root)
    const binaryText = buildBinaryDecoy(root)
    symlinkSync('elsewhere.txt', join(root, 'link.txt'))

    const run = runScannerCommand(root)
    if (run.status !== 1) {
      problems.push(`scanning a directory of canaries exited ${String(run.status)}, expected 1`)
    }

    const lines = run.stdout.split('\n').filter((line) => line !== '')
    const summary = lines.at(-1) ?? ''
    const findingLines = lines.slice(0, -1)
    if (!/^\d+ finding\(s\)$/.test(summary))
      problems.push('the summary line is not the usual one')

    const found = new Set()
    for (const line of findingLines) {
      const parsed = FINDING_LINE.exec(line)
      const rule = parsed?.[1]
      const path = parsed?.[2]
      if (rule === undefined || path === undefined) {
        problems.push('a reported line is not `rule path:line`')
        continue
      }
      found.add(`${rule} ${path}`)
      if (path.startsWith('ok-')) problems.push(`near miss reported: ${path}`)
      if (path === 'decoy.bin' && rule !== 'binary') {
        problems.push('a binary file was read as text')
      }
    }

    for (const canary of canaries) {
      const expected = `${canary.id} ${canary.path.split(sep).join('/')}`
      if (!found.has(expected)) problems.push(`rule did not fire: ${expected}`)
    }
    if (!found.has('symlink link.txt')) problems.push('a symlink was not reported')
    if (!found.has('binary decoy.bin'))
      problems.push('a binary file was passed over in silence')

    // Nothing the scanner prints may contain what it matched.
    const printed = `${run.stdout}${run.stderr}`
    const secrets = [...canaries.map((canary) => canary.text), binaryText]
    for (const secret of secrets) {
      for (const piece of secret.split('\n')) {
        if (piece.length > 6 && printed.includes(piece))
          problems.push('output repeated a match')
      }
    }

    const cloudKey = 'AK' + 'IA' + '3QW7RTPLZC2MVHB4'
    const scanner = runSecretScanner(root, cloudKey)
    if (scanner.skipped) {
      // Fine on a laptop that has not installed it; never fine where this is the check.
      if (process.env.CI !== undefined && process.env.CI !== '') {
        problems.push('the secret scanner is not installed')
      } else {
        process.stdout.write('secret scanner not installed: its canary check was not run\n')
      }
    } else {
      if (scanner.status !== 1) problems.push('the secret scanner did not fail on its canary')
      if (scanner.output.includes(cloudKey))
        problems.push('the secret scanner printed its match')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  for (const problem of problems) process.stdout.write(`self-test ${problem}\n`)
  process.stdout.write(
    problems.length === 0
      ? 'self-test passed\n'
      : `self-test failed (${String(problems.length)})\n`,
  )
  return problems.length === 0 ? 0 : 1
}

/* ----------------------------------------------------------------------- main ---- */

function main(argv) {
  if (argv.includes('--self-test')) {
    if (argv.length > 1) {
      process.stderr.write('usage: scan-denylist.mjs --self-test\n')
      return 2
    }
    return selfTest()
  }
  if (argv.length > 1) {
    process.stderr.write('usage: scan-denylist.mjs [dir] | --self-test\n')
    return 2
  }
  const dir = argv[0] ?? '.'
  if (!existsSync(dir)) {
    process.stderr.write(`no such directory: ${dir}\n`)
    return 2
  }
  const findings = scanDirectory(dir)
  report(findings)
  return findings.length === 0 ? 0 : 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`scan failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
  process.exitCode = 2
}
