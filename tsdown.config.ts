import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/postgres.ts', 'src/conformance.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  outDir: 'dist',
  target: 'node20',
  platform: 'neutral',
  clean: true,
  treeshake: true,
  // Shared declarations land in a chunk once more than one entry point uses them. Naming that
  // chunk by content would move it on every edit, and `api/` records it like any other part of
  // the published surface.
  hash: false,
  tsconfig: 'tsconfig.build.json',
  // Zod is a peer dependency, so it is resolved from the consumer and never bundled; tsdown
  // keeps peer dependencies external on its own, and this says so out loud. Node's own modules
  // belong to the runtime as well: the entry that hashes its migration reaches for
  // `node:crypto`, and the bundler has to leave that import exactly where it is rather than
  // try to resolve it for a neutral platform.
  deps: { neverBundle: ['zod', /^node:/] },
  // Report a manifest or declaration problem at build time rather than at install time.
  publint: true,
  // `node16` rather than the strictest profile: the exports map deliberately has no
  // legacy fallback for the subpaths, because the package targets Node 20 and up and the
  // resolvers that predate `exports` cannot see the subpaths at all.
  attw: { profile: 'node16' },
})
