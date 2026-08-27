/**
 * The one strict reading of the README's Quickstart section, shared by the fixture checker
 * and the walk-through so the two gates can never disagree about what the printed
 * quickstart is.
 *
 * The section runs from the `## Quickstart` heading, which must occur exactly once in the
 * whole document, to the next `## ` heading. Inside it there must be exactly one `bash`
 * fence followed by one `ts` fence. Fences follow CommonMark: any ``` line with an info
 * string opens one, and only a bare ``` line closes one: a ```-prefixed line WITH an info
 * string inside an open fence is content, not a closer. Anything else is reported, never
 * guessed at, so a README restructure fails the gates loudly instead of silently checking
 * the wrong code.
 */

/**
 * `{ install, code, codeOpenerIndex }`: the install command, the ts fence body (verbatim,
 * trailing newline), and the 0-based line index of the ts fence's opener, or `null` after
 * pushing the reason into `problems`.
 */
export function readQuickstart(readmeText, problems) {
  const name = 'README.md (## Quickstart)'
  const lines = readmeText.split('\n')

  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '## Quickstart') headings.push(index)
  }
  const start = headings[0]
  if (headings.length !== 1 || start === undefined) {
    problems.push(
      `${name}: expected exactly one '## Quickstart' heading, found ${String(headings.length)}`,
    )
    return null
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ') === true) {
      end = index
      break
    }
  }

  const fences = []
  let open = null
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined || !line.startsWith('```')) continue
    if (open === null) {
      open = { info: line.slice(3).trim(), openerIndex: index }
      continue
    }
    // Only a bare ``` closes a fence; ```something inside one is content.
    if (line.trim() === '```') {
      fences.push({ ...open, closerIndex: index })
      open = null
    }
  }
  if (open !== null) {
    problems.push(
      `${name}: the code fence opened at line ${String(open.openerIndex + 1)} never closes`,
    )
    return null
  }
  const [installFence, codeFence] = fences
  if (fences.length !== 2 || installFence?.info !== 'bash' || codeFence?.info !== 'ts') {
    problems.push(
      `${name}: expected exactly one \`\`\`bash fence then one \`\`\`ts fence in the section, ` +
        `found [${fences.map((fence) => fence.info || '(none)').join(', ')}]`,
    )
    return null
  }

  return {
    install: lines
      .slice(installFence.openerIndex + 1, installFence.closerIndex)
      .join('\n')
      .trim(),
    code: `${lines.slice(codeFence.openerIndex + 1, codeFence.closerIndex).join('\n')}\n`,
    codeOpenerIndex: codeFence.openerIndex,
  }
}
