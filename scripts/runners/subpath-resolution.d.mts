/**
 * Declares `./subpath-resolution.mjs`, which exists only once a runner has been copied into a
 * scratch project, so the runners are type-checked in the repository like every other script.
 *
 * Kept in step with `../lib/subpath-resolution.mjs` by hand.
 *
 * @module
 */

/** Every specifier the installed package publishes, read off its own `exports` map. */
export declare function publishedSubpaths(manifest: {
  name?: unknown
  exports?: unknown
}): string[]

/** Confirms every published subpath resolves inside this project's own copy of the package. */
export declare function assertInstalledPackageResolves(): {
  subpath: string
  file: string
}[]
