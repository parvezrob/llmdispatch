/**
 * Reading a JSON object out of what a model actually returned.
 *
 * The live check's JSON call is asked for in a prompt on the adapters that have no native way
 * of asking, so what comes back is a model's idea of "only this object": it may arrive in a
 * code fence, or with a sentence around it. That is tolerated here — the object is taken out
 * of the fence, or the first balanced `{…}` is read out of the text — because the claim under
 * check is that the adapter delivers usable JSON-shaped output, not that a model can follow an
 * instruction about whitespace. An empty object is not tolerated: it parses, and it proves
 * nothing.
 *
 * This lives beside `live-check.mjs` rather than inside it, and is copied into the scratch
 * project with it, so the reading can be held to examples in a test without the runner itself
 * having to know whether it is being run or imported. A runner that decides that for itself
 * gets it wrong the first time a path is a symlink.
 *
 * @module
 */

/**
 * The first balanced `{…}` in a string, or `null` when there is none.
 *
 * Braces inside string literals are skipped, so a value like `"}"` does not close the object
 * early. This reads one object out of surrounding prose; it is not a JSON parser, and what it
 * finds is handed to `JSON.parse` to be judged.
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

/** The output as it might have been meant, most literal reading first. */
function jsonCandidates(text) {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /```[A-Za-z]*\n([\s\S]*?)```/.exec(trimmed)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const braced = firstBracedSpan(trimmed)
  if (braced !== null) candidates.push(braced)
  return candidates
}

/**
 * Adds a problem unless the output is a non-empty JSON object at the top level.
 *
 * @param {string} text What the provider returned.
 * @param {string[]} problems The run's problem list, appended to in place.
 */
export function checkJsonShape(text, problems) {
  let firstParsed
  for (const candidate of jsonCandidates(text)) {
    let value
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (firstParsed === undefined) firstParsed = { value }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    // An object that parses and says nothing is what comes back when a provider has given up
    // on the request; accepting it would leave this check unable to fail.
    if (Object.keys(value).length === 0) {
      problems.push('the JSON call: the output was an empty object, which proves nothing')
    }
    return
  }
  problems.push(
    firstParsed === undefined
      ? 'the JSON call: the output did not parse as JSON, in a code fence or otherwise'
      : 'the JSON call: the output parsed, but not to a JSON object',
  )
}
