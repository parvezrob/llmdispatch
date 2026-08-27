/**
 * What `./subpath-resolution.mjs` is, from where the runners sit.
 *
 * The runners are copied into a throwaway project beside a copy of
 * `../lib/subpath-resolution.mjs` and import it from there, so in the repository that
 * specifier resolves to nothing and the type checker has no way to reach the implementation.
 * This file is that reach: it declares the module the copy provides, so the runners are
 * checked here like every other script instead of being excluded from the program and going
 * unchecked until the day they run.
 *
 * It has to be kept in step with `../lib/subpath-resolution.mjs` by hand. That is a surface of
 * two functions, and the alternative is not checking the runners at all.
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
