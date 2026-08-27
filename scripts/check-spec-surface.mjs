#!/usr/bin/env node
/**
 * Regenerates `test/types/spec-surface*.d.ts` from the §6 and §6b code fences of
 * docs/spec.md, compiles them with the fixtures' own options, and compares every name
 * `dist/` exports — ESM and CommonJS, type told apart from value — with what the spec says.
 *
 * A spec name the implementation has not reached yet belongs in `spec-pending.json`; any
 * other difference is a failure. Signatures are not compared: printed text does not
 * establish what a name resolves to, which is what the `api/*.d.ts` diff is read for.
 *
 * Usage: node scripts/check-spec-surface.mjs [--update]
 * Exit codes: 0 everything agrees, 1 something does not, 2 bad arguments.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')
const SPEC = join(ROOT, 'docs', 'spec.md')
const TYPES_DIR = join(ROOT, 'test', 'types')
const PENDING = join(TYPES_DIR, 'spec-pending.json')
const USAGE = 'usage: check-spec-surface.mjs [--update]\n'

const HEADER =
  '// Generated from the code fences of docs/spec.md by scripts/check-spec-surface.mjs.\n' +
  '// Edit the spec, then run `npm run surface:update`.\n\n'

/** Where each entry point's surface is generated. */
const ENTRY_POINTS = [
  { entry: 'index', surface: 'spec-surface.d.ts' },
  { entry: 'postgres', surface: 'spec-surface-postgres.d.ts' },
  { entry: 'conformance', surface: 'spec-surface-conformance.d.ts' },
]

/** The comments §6b uses to say which subpath the declarations under them belong to. */
const SUBPATH_MARKERS = {
  postgres: '// subpath: llmdispatch/postgres',
  conformance: '// subpath: llmdispatch/conformance',
}

/** A section: its heading down to the next one of the same level. */
function sectionAfter(markdown, heading, problems) {
  const at = markdown.indexOf(heading)
  if (at === -1) {
    problems.push(`docs/spec.md has no heading '${heading.trim()}'`)
    return null
  }
  const next = markdown.indexOf('\n## ', at + heading.length)
  return markdown.slice(at, next === -1 ? markdown.length : next)
}

/** Every fenced block in a section, in either CommonMark fence form. */
function fences(section) {
  const lines = section.split('\n')
  const blocks = []
  let open = null
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker?.[1] === undefined) continue
    const rail = marker[1]
    const info = (marker[2] ?? '').trim()
    if (open === null) {
      open = { rail, info, from: index + 1 }
      continue
    }
    // A closing rail is the same character, no shorter, and carries no info string.
    if (rail[0] !== open.rail[0] || rail.length < open.rail.length || info !== '') continue
    blocks.push({ info: open.info, body: `${lines.slice(open.from, index).join('\n')}\n` })
    open = null
  }
  return { blocks, unclosed: open !== null }
}

/** The body of a section's one `ts` fence; reading the first of several would publish half. */
function soleFence(section, label, problems) {
  const before = problems.length
  const { blocks, unclosed } = fences(section)
  if (unclosed) problems.push(`a code fence in ${label} is not closed`)
  for (const block of blocks) {
    if (block.info !== 'ts') {
      problems.push(`a code fence in ${label} is labelled '${block.info}'; it must be 'ts'`)
    }
  }
  if (blocks.length !== 1) {
    problems.push(`${label} has ${String(blocks.length)} code fences; it must have exactly one`)
  }
  const only = blocks[0]
  return problems.length > before || only === undefined ? null : only.body
}

/** The names a chunk of declarations exports, read off the declaration keywords. */
function declaredNames(text) {
  const names = new Set()
  const pattern =
    /^export\s+(?:declare\s+)?(?:interface|type|class|function|const)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

/**
 * The import line a subpath surface needs to stand on its own.
 *
 * §6b names §6's types freely; compiled alone it would not know what a `UsageStore` is.
 */
function importPrelude(chunk, sectionSixNames) {
  const own = declaredNames(chunk)
  // Comments come out first: §6b's prose names types the declarations never mention, and
  // importing one of those would leave the surface with an unused import.
  const code = chunk.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ')
  const needed = [...sectionSixNames]
    .filter((name) => !own.has(name))
    .filter((name) => new RegExp(`\\b${name}\\b`).test(code))
    .sort()
  if (needed.length === 0) return ''
  return `import type { ${needed.join(', ')} } from './spec-surface'\n\n`
}

/** Splits the §6b fence at its subpath markers, keeping each marker with its declarations. */
function splitSubpaths(fence, problems) {
  const found = []
  for (const [entry, marker] of Object.entries(SUBPATH_MARKERS)) {
    const at = fence.indexOf(marker)
    if (at === -1) {
      problems.push(`the §6b fence has no '${marker}' marker`)
      continue
    }
    if (fence.indexOf(marker, at + marker.length) !== -1) {
      problems.push(`the §6b fence has more than one '${marker}' marker`)
    }
    found.push({ entry, at })
  }
  if (problems.length > 0) return null
  found.sort((a, b) => a.at - b.at)

  const first = found[0]
  if (first === undefined) return null
  if (fence.slice(0, first.at).trim() !== '') {
    problems.push('the §6b fence has declarations above its first `// subpath:` marker')
    return null
  }

  const chunks = {}
  for (const [index, { entry, at }] of found.entries()) {
    const next = found[index + 1]
    chunks[entry] =
      fence.slice(at, next === undefined ? fence.length : next.at).trimEnd() + '\n'
  }

  // A name that landed in no chunk would be a published export nothing ever compares against.
  const placed = new Set()
  for (const chunk of Object.values(chunks))
    for (const name of declaredNames(chunk)) placed.add(name)
  for (const name of declaredNames(fence)) {
    if (!placed.has(name)) problems.push(`§6b declares ${name}, which no subpath marker claims`)
  }
  return problems.length > 0 ? null : chunks
}

/** What every entry point's surface should contain, generated from the spec. */
function generateSurfaces(problems) {
  const markdown = readFileSync(SPEC, 'utf8')
  const sixSection = sectionAfter(markdown, '\n## 6. Public API', problems)
  const sixBSection = sectionAfter(markdown, '\n## 6b. Packaged operational surfaces', problems)
  if (sixSection === null || sixBSection === null) return null

  const sectionSix = soleFence(sixSection, 'spec §6', problems)
  const sectionSixB = soleFence(sixBSection, 'spec §6b', problems)
  if (sectionSix === null || sectionSixB === null) return null

  const chunks = splitSubpaths(sectionSixB, problems)
  if (chunks === null) return null

  const sectionSixNames = declaredNames(sectionSix)
  const surfaces = { index: HEADER + sectionSix }
  for (const [entry, chunk] of Object.entries(chunks)) {
    surfaces[entry] = HEADER + importPrelude(chunk, sectionSixNames) + chunk
  }
  return surfaces
}

/** Writes the generated surfaces, or reports the ones that have drifted. */
function reconcileSurfaces(surfaces, update, problems) {
  for (const { entry, surface } of ENTRY_POINTS) {
    const path = join(TYPES_DIR, surface)
    const expected = surfaces[entry]
    if (expected === undefined) {
      problems.push(`no surface was generated for '${entry}'`)
      continue
    }
    if (update) {
      writeFileSync(path, expected)
      continue
    }
    const recorded = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (recorded !== expected) {
      problems.push(
        `test/types/${surface} no longer matches docs/spec.md — run \`npm run surface:update\``,
      )
    }
  }
}

/** The options the compile fixtures use, so the surfaces are held to the same bar. */
function fixtureOptions() {
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

/**
 * Compiles the three surfaces together.
 *
 * A misspelt type would otherwise generate a surface that resolves to `any` wherever it is
 * used, and every fixture would still pass.
 */
function compileSurfaces(problems) {
  const paths = ENTRY_POINTS.map(({ surface }) => join(TYPES_DIR, surface))
  const program = ts.createProgram(paths, fixtureOptions())
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    const file = diagnostic.file
    if (file === undefined || diagnostic.start === undefined) {
      problems.push(`the generated surfaces: TS${String(diagnostic.code)}: ${message}`)
      continue
    }
    const { line } = file.getLineAndCharacterOfPosition(diagnostic.start)
    problems.push(
      `${relative(ROOT, file.fileName)}:${String(line + 1)} TS${String(diagnostic.code)}: ${message}`,
    )
  }
  return program
}

/**
 * The names an entry file publishes type-only, however that is written.
 *
 * `export type * from './dep'` leaves no `ExportSpecifier` behind, so the class it re-exports
 * still looks like a value to anyone who asks the symbol.
 */
function typeOnlyExports(checker, source) {
  const names = new Set()
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.isTypeOnly) continue
    const clause = statement.exportClause
    if (clause !== undefined) {
      if (ts.isNamespaceExport(clause)) names.add(clause.name.text)
      else for (const element of clause.elements) names.add(element.name.text)
      continue
    }
    const specifier = statement.moduleSpecifier
    if (specifier === undefined) continue
    const module = checker.getSymbolAtLocation(specifier)
    if (module === undefined) continue
    for (const exported of checker.getExportsOfModule(module)) names.add(exported.name)
  }
  return names
}

/** Whether a name is exported as a value or only as a type; the syntax has the first word. */
function exportedKind(checker, symbol, typeOnly) {
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
  if ((target.flags & ts.SymbolFlags.Value) === 0) return 'type'
  // A named export overrides a star export of the same name, so it decides on its own.
  const specifiers = (symbol.declarations ?? []).filter((node) => ts.isExportSpecifier(node))
  if (specifiers.length > 0) {
    return specifiers.some((node) => !node.isTypeOnly && !node.parent.parent.isTypeOnly)
      ? 'value'
      : 'type'
  }
  return typeOnly.has(symbol.name) ? 'type' : 'value'
}

/** Every name a declaration file exports, with whether it is a value or only a type. */
function inventory(program, path) {
  const source = program.getSourceFile(path)
  if (source === undefined) throw new Error(`could not read ${path}`)
  const checker = program.getTypeChecker()
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (moduleSymbol === undefined) throw new Error(`${path} is not a module`)
  const typeOnly = typeOnlyExports(checker, source)
  const found = new Map()
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    found.set(symbol.name, exportedKind(checker, symbol, typeOnly))
  }
  return found
}

/** Every way a name can be exported, and what each one publishes. */
const KIND_PROOF = {
  '/kind-proof-dep.d.ts':
    'export declare class ReExportedAsTypeOnly {}\n' +
    'export declare class ReExportedBothWays {}\n' +
    'export interface ReExportedInterface {\n  a: string\n}\n',
  '/kind-proof.d.ts':
    'declare class ExportedInPlace {}\n' +
    'declare class ExportedBySpecifier {}\n' +
    'declare class ExportedAsTypeOnly {}\n' +
    'declare class ExportedInATypeClause {}\n' +
    'interface PlainInterface {\n  a: string\n}\n' +
    'export declare function exportedDirectly(): void\n' +
    'export { ExportedInPlace }\n' +
    'export { ExportedBySpecifier, type ExportedAsTypeOnly, PlainInterface }\n' +
    'export type { ExportedInATypeClause }\n' +
    "export type * from './kind-proof-dep'\n" +
    "export { ReExportedBothWays } from './kind-proof-dep'\n",
}

/** What `inventory` has to say about each of them. */
const KIND_PROOF_EXPECTED = {
  exportedDirectly: 'value',
  ExportedInPlace: 'value',
  ExportedBySpecifier: 'value',
  ExportedAsTypeOnly: 'type',
  ExportedInATypeClause: 'type',
  PlainInterface: 'type',
  ReExportedAsTypeOnly: 'type',
  ReExportedBothWays: 'value',
  ReExportedInterface: 'type',
}

/**
 * Proves the type-versus-value decision on a file written for the purpose, every run.
 *
 * Getting it wrong is silent: every name would still be present, so the inventory would agree
 * with itself while the package published something else.
 */
function proveKindDecision(problems) {
  const host = {
    fileExists: (name) => Object.hasOwn(KIND_PROOF, name),
    readFile: (name) => KIND_PROOF[name],
    getSourceFile: (name) => {
      const text = KIND_PROOF[name]
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram(
    Object.keys(KIND_PROOF),
    {
      noEmit: true,
      noLib: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    host,
  )
  const found = inventory(program, '/kind-proof.d.ts')
  for (const [name, kind] of Object.entries(KIND_PROOF_EXPECTED)) {
    const reported = found.get(name)
    if (reported !== kind) {
      problems.push(
        `this script reports ${name} as ${reported ?? 'nothing'} when it is exported as a ${kind}; ` +
          'the inventory below cannot be trusted',
      )
    }
  }
  for (const name of found.keys()) {
    if (!Object.hasOwn(KIND_PROOF_EXPECTED, name)) {
      problems.push(`this script found an unexpected export ${name} in its own proof file`)
    }
  }
}

/** Both declaration files of every entry point, as the package publishes them. */
function distPaths() {
  const paths = []
  for (const { entry } of ENTRY_POINTS) {
    paths.push(join(ROOT, 'dist', `${entry}.d.ts`), join(ROOT, 'dist', `${entry}.d.cts`))
  }
  return paths
}

/** What each entry point declares in the spec and publishes in each of the two builds. */
function readInventories(specProgram) {
  const distProgram = ts.createProgram(distPaths(), {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })

  const inventories = new Map()
  for (const { entry, surface } of ENTRY_POINTS) {
    inventories.set(entry, {
      spec: inventory(specProgram, join(TYPES_DIR, surface)),
      esm: inventory(distProgram, join(ROOT, 'dist', `${entry}.d.ts`)),
      cjs: inventory(distProgram, join(ROOT, 'dist', `${entry}.d.cts`)),
    })
  }
  return inventories
}

/** Reads the list of spec names that are not implemented yet. */
function readPending() {
  const raw = JSON.parse(readFileSync(PENDING, 'utf8'))
  const pending = new Map()
  for (const { entry } of ENTRY_POINTS) {
    const listed = raw[entry]
    if (listed === undefined) throw new Error(`spec-pending.json has no '${entry}' entry`)
    const names = new Map()
    for (const kind of ['value', 'type']) {
      const list = listed[kind]
      if (!Array.isArray(list))
        throw new Error(`spec-pending.json '${entry}.${kind}' is not a list`)
      for (const name of list) names.set(name, kind)
    }
    pending.set(entry, names)
  }
  return pending
}

/** The pending list as the released branch has it, or `null` when it cannot be read. */
function releasedPending() {
  for (const ref of ['origin/main', 'main']) {
    const shown = spawnSync('git', ['show', `${ref}:test/types/spec-pending.json`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    if (shown.status !== 0 || typeof shown.stdout !== 'string') continue
    try {
      return JSON.parse(shown.stdout)
    } catch {
      return null
    }
  }
  return null
}

/**
 * The pending list may only ever shrink.
 *
 * Each scope removes the names it lands. Adding one back would hide an export that used to be
 * published, or excuse a name the spec declares and nothing implements any more.
 */
function checkPendingShrinks(problems) {
  const released = releasedPending()
  if (released === null) {
    problems.push(
      'the pending list could not be compared with main: fetch it (a shallow checkout has ' +
        'neither origin/main nor main) so a name cannot be added back unnoticed',
    )
    return
  }
  const current = JSON.parse(readFileSync(PENDING, 'utf8'))
  for (const { entry } of ENTRY_POINTS) {
    for (const kind of ['value', 'type']) {
      const before = new Set(released[entry]?.[kind] ?? [])
      for (const name of current[entry]?.[kind] ?? []) {
        if (before.has(name)) continue
        problems.push(
          `spec-pending.json lists ${name} as a pending ${kind} of '${entry}', which main does not: the list may only shrink`,
        )
      }
    }
  }
}

/** Compares one entry point's spec surface with what the two builds publish. */
function comparePublished(entry, found, pending, problems) {
  const { spec, esm, cjs } = found
  for (const [name, kind] of esm) {
    if (cjs.get(name) !== kind) {
      problems.push(
        `${entry}: the ESM build exports ${name} as a ${kind}, the CommonJS build does not`,
      )
    }
  }
  for (const name of cjs.keys()) {
    if (!esm.has(name))
      problems.push(`${entry}: the CommonJS build exports ${name}, the ESM build does not`)
  }

  for (const [name, kind] of pending) {
    if (!spec.has(name))
      problems.push(`${entry}: ${name} is listed as pending but the spec does not declare it`)
    if (esm.has(name)) {
      problems.push(
        `${entry}: ${name} is published but still listed in spec-pending.json — remove it there`,
      )
    }
    if (spec.get(name) !== kind) {
      problems.push(
        `${entry}: ${name} is listed as a pending ${kind} but the spec declares it otherwise`,
      )
    }
  }

  for (const [name, kind] of spec) {
    if (pending.has(name)) continue
    const published = esm.get(name)
    if (published === undefined)
      problems.push(`${entry}: the spec declares ${name} but dist does not export it`)
    else if (published !== kind) {
      problems.push(
        `${entry}: the spec declares ${name} as a ${kind}, dist publishes it as a ${published}`,
      )
    }
  }

  for (const name of esm.keys()) {
    if (!spec.has(name))
      problems.push(`${entry}: dist exports ${name}, which the spec does not declare`)
  }
}

/** Prints whatever went wrong and fails. */
function report(problems) {
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  return 1
}

/** The flags, or `null` when they do not make sense. */
function readArguments(argv) {
  let update = false
  for (const argument of argv) {
    if (argument !== '--update') {
      process.stderr.write(`unknown argument '${argument}'\n${USAGE}`)
      return null
    }
    if (update) {
      process.stderr.write(`'--update' was given twice\n${USAGE}`)
      return null
    }
    update = true
  }
  return { update }
}

function main() {
  const parsed = readArguments(process.argv.slice(2))
  if (parsed === null) return 2
  const { update } = parsed
  const problems = []

  proveKindDecision(problems)
  if (problems.length > 0) return report(problems)

  const surfaces = generateSurfaces(problems)
  if (surfaces === null) return report(problems)

  reconcileSurfaces(surfaces, update, problems)
  if (problems.length > 0) return report(problems)

  const specProgram = compileSurfaces(problems)
  if (problems.length > 0) return report(problems)

  checkPendingShrinks(problems)
  if (problems.length > 0) return report(problems)

  // `--update` has to work on a checkout that was never built, or a spec edit could not be
  // taken up without a build first.
  const missing = distPaths().filter((path) => !existsSync(path))
  if (missing.length > 0) {
    if (!update) {
      problems.push(
        `${relative(ROOT, missing[0] ?? '')} is missing — run \`npm run build\` first`,
      )
      return report(problems)
    }
    process.stdout.write(
      'spec surfaces regenerated and compiled; dist is not built, so the exports were not compared\n',
    )
    return 0
  }

  const inventories = readInventories(specProgram)
  const pending = readPending()
  for (const { entry } of ENTRY_POINTS) {
    const found = inventories.get(entry)
    const listed = pending.get(entry)
    if (found === undefined || listed === undefined)
      throw new Error(`no inventory for '${entry}'`)
    comparePublished(entry, found, listed, problems)
  }
  if (problems.length > 0) return report(problems)

  const counted = [...inventories.values()].reduce((total, found) => total + found.spec.size, 0)
  process.stdout.write(
    `${update ? 'spec surfaces regenerated' : 'spec surfaces current'} and compiled; ` +
      `${String(counted)} declared names checked against dist\n`,
  )
  return 0
}

process.exitCode = main()
