/**
 * The environment a spawned child is given, as an allowlist rather than a filter: the
 * child sees these names and nothing else. An inherited proxy, a `NODE_OPTIONS` preload,
 * a `NODE_PATH`, or an npm credential from the ambient shell would each change what a
 * verification run proves, and a filter only removes the names someone thought of.
 */

/** Every name a child may receive. Anything else is a mistake, not something to pass on. */
const ALLOWED = new Set([
  'PATH',
  'HOME',
  'CI',
  'NEXT_TELEMETRY_DISABLED',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PORT',
  'HOST',
  'EXAMPLE_READY_TOKEN',
])

/**
 * Builds that environment.
 *
 * @param {string} home A temporary directory the child may treat as `HOME`, so caches and
 *   anything a tool writes for itself land there and go away with the run.
 * @param {Record<string, string | undefined>} [values] Further allowlisted names; a value
 *   of `undefined` leaves the name unset.
 * @returns {Record<string, string>} The complete child environment.
 */
export function buildChildEnvironment(home, values = {}) {
  /** @type {Record<string, string>} */
  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  for (const [name, value] of Object.entries(values)) {
    if (!ALLOWED.has(name)) {
      throw new RangeError(`'${name}' is not one of the variables a child may be given`)
    }
    if (value !== undefined) environment[name] = value
  }
  return environment
}
