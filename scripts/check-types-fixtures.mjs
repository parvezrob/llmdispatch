#!/usr/bin/env node
/**
 * Compiles every fixture under `test/types/` in a program of its own — one at a time, since
 * the negative ones are meant to fail — and checks that each behaves as it says it will.
 *
 * Line one is `// @targets spec[, package]`: `spec` is what docs/spec.md declares, `package`
 * what the build ships, and every fixture must target `spec`, the only run that happens
 * before a build. Positive fixtures compile silently; negative ones carry `// @expect TS####`
 * on the line above the offending one and must produce exactly that and nothing else. A
 * suppression or an `any` is refused: either would let a fixture compile proving nothing.
 *
 * One fixture does not live on disk: the README quickstart's TypeScript fence is extracted
 * verbatim at check time and compiled in memory against both targets. The printed example
 * is therefore the compiled example — there is no second copy to drift, and the fence never
 * carries a `@targets` header the reader shouldn't see.
 *
 * Usage: node scripts/check-types-fixtures.mjs [--target spec|package]
 * Exit codes: 0 all behaved, 1 one did not, 2 bad arguments.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

import { readQuickstart } from './lib/quickstart-section.mjs'

const ROOT = join(import.meta.dirname, '..')
const TYPES_DIR = join(ROOT, 'test', 'types')
const SCAFFOLD = join(TYPES_DIR, 'scaffold.d.ts')
const README = join(ROOT, 'README.md')
const USAGE = 'usage: check-types-fixtures.mjs [--target spec|package]\n'

/** Where `llmdispatch` and its subpaths point for each target. */
const TARGETS = {
  spec: {
    llmdispatch: './spec-surface.d.ts',
    'llmdispatch/postgres': './spec-surface-postgres.d.ts',
    'llmdispatch/conformance': './spec-surface-conformance.d.ts',
  },
  package: {
    llmdispatch: '../../dist/index.d.ts',
    'llmdispatch/postgres': '../../dist/postgres.d.ts',
    'llmdispatch/conformance': '../../dist/conformance.d.ts',
  },
}

/** Anything that could hide a diagnostic. */
const SUPPRESSIONS = ['@ts-expect-error', '@ts-ignore', '@ts-nocheck', 'eslint-disable']

/** The options the fixtures are compiled with, read from their own tsconfig. */
function readBaseOptions() {
  const configPath = join(TYPES_DIR, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'))
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, TYPES_DIR)
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    )
  }
  return parsed.options
}

/** Comments as the compiler sees them, so a `//` inside a string literal is not one. */
function scanComments(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    text,
  )
  const found = []
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const single = token === ts.SyntaxKind.SingleLineCommentTrivia
    if (!single && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    found.push({ single, start: scanner.getTokenStart(), text: scanner.getTokenText() })
  }
  return found
}

/** Every position at which a fixture writes the `any` type. */
function anyKeywords(source) {
  const found = []
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) found.push(node.getStart(source))
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/** The `@targets` header and `@expect` markers, read only from comments the scanner found. */
function readHeader(fixture, problems) {
  const { kind, name, text, source, comments } = fixture
  const lineOf = (position) => source.getLineAndCharacterOfPosition(position)

  const opening = comments.find((comment) => comment.start === 0)
  const header =
    opening?.single === true ? /^\/\/ @targets (.+)$/.exec(opening.text.trim()) : null
  if (header?.[1] === undefined) {
    problems.push(`${name}:1: the first line must be '// @targets spec[, package]'`)
    return null
  }
  const targets = header[1].split(',').map((target) => target.trim())
  for (const target of targets) {
    if (!Object.hasOwn(TARGETS, target)) {
      problems.push(`${name}:1: unknown target '${target}'`)
      return null
    }
  }
  if (!targets.includes('spec')) {
    problems.push(
      `${name}:1: every fixture must target 'spec'; this one targets ${targets.join(', ')}`,
    )
    return null
  }

  const expected = []
  let malformed = false
  for (const comment of comments) {
    if (!comment.single || !comment.text.trim().startsWith('// @expect')) continue
    const { line, character } = lineOf(comment.start)
    if (text.slice(comment.start - character, comment.start).trim() !== '') {
      problems.push(
        `${name}:${String(line + 1)}: an '@expect' marker must be alone on its line`,
      )
      malformed = true
      continue
    }
    const marker = /^\/\/ @expect (TS\d+(?: TS\d+)*)$/.exec(comment.text.trim())
    if (marker?.[1] === undefined) {
      problems.push(
        `${name}:${String(line + 1)}: a marker must read '// @expect TS####', further codes separated by single spaces`,
      )
      malformed = true
      continue
    }
    for (const code of marker[1].split(' ')) {
      expected.push({ line: line + 2, code: Number(code.slice(2)) })
    }
  }
  if (malformed) return null

  // A negative fixture with no marker would pass by compiling cleanly, the exact opposite of
  // what it claims; a positive one with a marker claims two things and is checked for one.
  if (kind === 'negative' && expected.length === 0) {
    problems.push(
      `${name}: a negative fixture must carry at least one '// @expect TS####' marker`,
    )
    return null
  }
  if (kind === 'positive' && expected.length > 0) {
    problems.push(
      `${name}: a positive fixture compiles cleanly, so it carries no '@expect' marker`,
    )
    return null
  }
  return { targets, expected }
}

/**
 * The README quickstart's `ts` fence, extracted verbatim as an in-memory positive fixture.
 * The strict shared extractor refuses anything but the expected section shape, so a README
 * restructure can never silently compile the wrong fence. `lineOffset` maps fence-relative
 * diagnostic lines back to real README.md line numbers.
 */
function readReadmeFixture(problems) {
  const quickstart = readQuickstart(readFileSync(README, 'utf8'), problems)
  if (quickstart === null) return null
  const text = quickstart.code
  const path = join(TYPES_DIR, 'positive', 'readme-quickstart.generated.ts')
  return {
    kind: 'positive',
    virtual: true,
    path,
    name: 'README.md (## Quickstart ts fence)',
    text,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    comments: scanComments(text),
    targets: ['spec', 'package'],
    expected: [],
    lineOffset: quickstart.codeOpenerIndex + 1,
  }
}

/** Every fixture that declares itself properly; the rest are reported and left out. */
function readFixtures(problems) {
  const fixtures = []
  for (const kind of ['positive', 'negative']) {
    for (const file of readdirSync(join(TYPES_DIR, kind)).sort()) {
      if (!file.endsWith('.ts')) continue
      const path = join(TYPES_DIR, kind, file)
      const text = readFileSync(path, 'utf8')
      const fixture = {
        kind,
        path,
        name: `test/types/${kind}/${file}`,
        text,
        source: ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
        comments: scanComments(text),
      }
      const header = readHeader(fixture, problems)
      if (header !== null) fixtures.push({ ...fixture, ...header })
    }
  }
  const readme = readReadmeFixture(problems)
  if (readme !== null) fixtures.push(readme)
  return fixtures
}

/** Refuses a fixture that hides a diagnostic or writes `any`; either would void the proof. */
function readableSource(fixture, problems) {
  const before = problems.length
  const at = (position) =>
    String(fixture.source.getLineAndCharacterOfPosition(position).line + 1)

  for (const comment of fixture.comments) {
    for (const suppression of SUPPRESSIONS) {
      if (!comment.text.includes(suppression)) continue
      problems.push(
        `${fixture.name}:${at(comment.start)}: contains '${suppression}', which would hide the diagnostic it exists to prove`,
      )
    }
  }
  for (const position of anyKeywords(fixture.source)) {
    problems.push(
      `${fixture.name}:${at(position)}: writes \`any\`, so whatever it compiles proves nothing`,
    )
  }
  return problems.length === before
}

/**
 * `{ line, code }` for every diagnostic, split into the fixture's own and everything else.
 * `lineOffset` shifts the fixture's own lines — for the README fence, whose line 1 is not
 * the README's line 1 — so every reported number is one the reader can jump to.
 */
function collectDiagnostics(program, fixturePath, lineOffset) {
  const own = []
  const foreign = []
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    if (file === undefined || diagnostic.start === undefined) {
      foreign.push({ where: 'the compiler options', line: 0, code: diagnostic.code, message })
      continue
    }
    const { line } = file.getLineAndCharacterOfPosition(diagnostic.start)
    const entry = {
      where: relative(ROOT, file.fileName),
      line: line + 1,
      code: diagnostic.code,
      message,
    }
    if (file.fileName === fixturePath.replaceAll('\\', '/') || file.fileName === fixturePath) {
      own.push({ ...entry, line: entry.line + lineOffset })
    } else foreign.push(entry)
  }
  return { own, foreign }
}

/** Diagnostics as a sorted, comparable list of `line:code` pairs. */
function asPairs(entries) {
  return entries.map(({ line, code }) => `${String(line)}:TS${String(code)}`).sort()
}

/**
 * A compiler host that serves one file from memory — the README fence, which exists at
 * check time only — and everything else from disk as usual.
 */
function virtualHost(options, fixture) {
  const host = ts.createCompilerHost(options)
  const served = fixture.path.replaceAll('\\', '/')
  const isServed = (fileName) => fileName.replaceAll('\\', '/') === served
  const { fileExists, readFile, getSourceFile } = host
  host.fileExists = (fileName) => isServed(fileName) || fileExists.call(host, fileName)
  host.readFile = (fileName) =>
    isServed(fileName) ? fixture.text : readFile.call(host, fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    isServed(fileName)
      ? ts.createSourceFile(fileName, fixture.text, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile.call(host, fileName, languageVersion, onError, shouldCreate)
  return host
}

/** Compiles one fixture against one target and reports whatever did not match. */
function checkFixture(fixture, target, baseOptions, problems) {
  const paths = {}
  for (const [specifier, location] of Object.entries(TARGETS[target]))
    paths[specifier] = [location]
  const options = { ...baseOptions, paths }
  const host = fixture.virtual === true ? virtualHost(options, fixture) : undefined
  const program = ts.createProgram([SCAFFOLD, fixture.path], options, host)
  const { own, foreign } = collectDiagnostics(program, fixture.path, fixture.lineOffset ?? 0)

  for (const entry of foreign) {
    problems.push(
      `${fixture.name} [${target}]: ${entry.where}:${String(entry.line)} TS${String(entry.code)}: ${entry.message}`,
    )
  }

  const actual = asPairs(own)
  const expected = asPairs(fixture.expected)
  if (actual.join('|') === expected.join('|')) return

  problems.push(
    `${fixture.name} [${target}]: expected ${expected.length === 0 ? 'no diagnostics' : expected.join(', ')}, ` +
      `got ${actual.length === 0 ? 'none' : actual.join(', ')}\n` +
      own
        .map(
          (entry) => `    line ${String(entry.line)} TS${String(entry.code)}: ${entry.message}`,
        )
        .join('\n'),
  )
}

/** The target to compile against, or `null` when the arguments do not make sense. */
function readArguments(argv) {
  let target = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--target') {
      process.stderr.write(`unknown argument '${String(argument)}'\n${USAGE}`)
      return null
    }
    if (target !== null) {
      process.stderr.write(`'--target' was given twice\n${USAGE}`)
      return null
    }
    index += 1
    const value = argv[index]
    if (value === undefined || !Object.hasOwn(TARGETS, value)) {
      process.stderr.write(
        `'--target' needs one of ${Object.keys(TARGETS).join(', ')}\n${USAGE}`,
      )
      return null
    }
    target = value
  }
  return target ?? 'spec'
}

function main() {
  const target = readArguments(process.argv.slice(2))
  if (target === null) return 2

  const baseOptions = readBaseOptions()
  const problems = []
  const fixtures = readFixtures(problems)
  let checked = 0
  for (const fixture of fixtures) {
    if (!readableSource(fixture, problems)) continue
    if (!fixture.targets.includes(target)) continue
    checkFixture(fixture, target, baseOptions, problems)
    checked += 1
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    return 1
  }
  process.stdout.write(
    `${String(checked)} of ${String(fixtures.length)} compile fixtures behave as documented against the ${target} surface\n`,
  )
  return 0
}

process.exitCode = main()
