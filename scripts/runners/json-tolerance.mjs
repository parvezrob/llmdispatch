/**
 * Reads a JSON object out of what a model returned for the live check's JSON call.
 *
 * On adapters with no native JSON mode the call is a prompt, so the object may arrive in a
 * code fence or wrapped in prose; both are tolerated. An empty object is not — it parses and
 * proves nothing.
 *
 * Copied into the scratch project alongside `live-check.mjs`, and kept separate from it so it
 * can be unit-tested without the runner needing to know whether it was run or imported.
 *
 * @module
 */

/**
 * The first balanced `{…}` in a string, or `null` when there is none. Braces inside string
 * literals are skipped. What it finds is handed to `JSON.parse` to be judged.
 */
function firstBracedSpan(text) {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/** Readings to try when the text as a whole is not JSON: a fenced body, then one object. */
function fallbackCandidates(trimmed) {
  const candidates = []
  const fenced = /```[A-Za-z]*\n([\s\S]*?)```/.exec(trimmed)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const braced = firstBracedSpan(trimmed)
  if (braced !== null) candidates.push(braced)
  return candidates
}

/** The parsed value wrapped in an object, or `null` when the text is not JSON. */
function parseJson(text) {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return null
  }
}

/** Why a parsed value is not the non-empty object the call asked for, or `null`. */
function describeValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'the JSON call: the output parsed, but not to a JSON object'
  }
  if (Object.keys(value).length === 0) {
    return 'the JSON call: the output was an empty object, which proves nothing'
  }
  return null
}

/**
 * Adds a problem unless the output is a non-empty JSON object at the top level.
 *
 * @param {string} text What the provider returned.
 * @param {string[]} problems The run's problem list, appended to in place.
 */
export function checkJsonShape(text, problems) {
  const trimmed = text.trim()

  // Valid JSON is judged as that value alone: falling through would let `[{"ok":true}]` pass
  // on the object nested inside it.
  const literal = parseJson(trimmed)
  if (literal !== null) {
    const problem = describeValue(literal.value)
    if (problem !== null) problems.push(problem)
    return
  }

  for (const candidate of fallbackCandidates(trimmed)) {
    const found = parseJson(candidate)
    if (found === null) continue
    const problem = describeValue(found.value)
    if (problem !== null) problems.push(problem)
    return
  }
  problems.push('the JSON call: the output did not parse as JSON, in a code fence or otherwise')
}
