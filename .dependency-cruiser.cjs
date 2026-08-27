'use strict'

/**
 * Module boundaries, enforced. The folder layout in `docs/architecture.md` is only a
 * convention until something checks it; this file is that something.
 *
 * The shape it protects: `errors` is the base layer, `core` decides, `providers` and
 * `stores` adapt, `conformance` tests foreign implementations through interfaces, and
 * only the entry modules assemble. Adding a provider or a store must never require an
 * edit inside `core`.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'core-decides-only',
      comment:
        'core may reach errors and the public types and nothing else in src: an import of a ' +
        'provider or a store here would make adding either an edit to the decision layer.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/', pathNot: '^(src/core/|src/errors/|src/types\\.ts$)' },
    },
    {
      name: 'core-does-no-io',
      comment:
        'core is pure: no filesystem, no network, no timers from Node built-ins. I/O belongs ' +
        'to providers and stores, which core reaches through interfaces.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'errors-are-the-base-layer',
      comment:
        'errors is what every other folder depends on, so it depends on nothing but itself ' +
        'and the public types. That is what keeps the graph acyclic.',
      severity: 'error',
      from: { path: '^src/errors/' },
      to: { path: '^src/', pathNot: '^(src/errors/|src/types\\.ts$)' },
    },
    {
      name: 'errors-do-no-io',
      comment:
        'constructing an error must not touch the outside world. An error that reads a file ' +
        'or a clock cannot be thrown from anywhere.',
      severity: 'error',
      from: { path: '^src/errors/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'types-declare-only',
      comment:
        'the public types are shapes, not behaviour: they import nothing but zod, so every ' +
        'other folder can depend on them without inheriting anything.',
      severity: 'error',
      from: { path: '^src/types\\.ts$' },
      to: { pathNot: '^node_modules/zod(/|$)' },
    },
    {
      name: 'providers-adapt-only',
      comment:
        'a provider adapter translates one API and reports what happened; it does not read ' +
        'core decisions, storage, or another adapter.',
      severity: 'error',
      from: { path: '^src/providers/' },
      to: { path: '^src/', pathNot: '^(src/providers/|src/errors/|src/types\\.ts$)' },
    },
    {
      name: 'stores-persist-only',
      comment:
        'a store persists and reports; it does not read core decisions or reach into a ' +
        'provider adapter.',
      severity: 'error',
      from: { path: '^src/stores/' },
      to: { path: '^src/', pathNot: '^(src/stores/|src/errors/|src/types\\.ts$)' },
    },
    {
      name: 'conformance-tests-interfaces',
      comment:
        'the harnesses exercise whatever implementation they are handed. Importing a built-in ' +
        'provider or store would mean testing that built-in instead.',
      severity: 'error',
      from: { path: '^src/conformance/' },
      to: { path: '^src/', pathNot: '^(src/conformance/|src/errors/|src/types\\.ts$)' },
    },
    {
      name: 'root-entry-assembles',
      comment:
        'the root entry is the one place core, providers and stores meet. It does not pull in ' +
        'the conformance harnesses or the SQL surface, which have their own entry points.',
      severity: 'error',
      from: { path: '^src/index\\.ts$' },
      to: {
        path: '^src/',
        pathNot:
          '^(src/core/|src/errors/|src/providers/|src/stores/|src/types\\.ts$|src/runtime\\.ts$)',
      },
    },
    {
      name: 'runtime-adapts-timers-only',
      comment:
        'the runtime adapter turns globalThis timers into the seam the core is handed; it ' +
        'may know the seam type and nothing else, and only the root entry wires it in.',
      severity: 'error',
      from: { path: '^src/runtime\\.ts$' },
      to: { path: '^src/', pathNot: '^src/core/runtime\\.ts$' },
    },
    {
      name: 'postgres-entry-is-narrow',
      comment:
        'the SQL entry point exposes the packaged migrations and the usage-statement marker ' +
        '(spec §6b), nothing else. `sql.ts` imports nothing, so naming the marker there costs ' +
        'the entry point one string and brings no store code with it.',
      severity: 'error',
      from: { path: '^src/postgres\\.ts$' },
      to: {
        path: '^src/',
        pathNot: ['^src/stores/postgres/migrations/', '^src/stores/postgres/sql\\.ts$'],
      },
    },
    {
      name: 'conformance-entry-is-narrow',
      comment: 'the conformance entry point exposes the harnesses, nothing else.',
      severity: 'error',
      from: { path: '^src/conformance\\.ts$' },
      to: { path: '^src/', pathNot: '^src/conformance/' },
    },
    {
      name: 'zod-is-the-only-package',
      comment:
        'the published package has no runtime dependencies. Zod is a peer dependency the ' +
        'adopter already installs; anything else would be a new install for them.',
      severity: 'error',
      from: { path: '^src/' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'npm-unknown',
        ],
        pathNot: '^node_modules/zod(/|$)',
      },
    },
    {
      name: 'no-circular',
      comment: 'a cycle means two modules are really one; split them or merge them.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'a module nothing imports is either dead or a missing export. The three entry modules ' +
        'are the exception: the manifest imports them, not another module.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: '^src/(index|postgres|conformance)\\.ts$',
      },
      to: {},
    },
    {
      name: 'no-unresolvable',
      comment: 'an import that does not resolve is a typo or a missing file.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.mts', '.cts', '.mjs', '.cjs'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: '^src/[^/]+' },
    },
  },
}
