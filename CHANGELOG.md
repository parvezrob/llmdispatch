# Changelog

## 0.2.0

### Minor Changes

- 70ef8be: `anthropic()` accepts a `baseUrl`, defaulting to `https://api.anthropic.com`, so Anthropic-format endpoints on other hosts are reachable the same way OpenAI-compatible ones already are.
- 078078b: The provider conformance suite can now verify document and image handling.
  `runProviderConformance` takes two further optional scenarios, `document` and `image`, plus
  a `requests` map supplying the request each one dispatches. Both halves are needed: a
  scenario without its request, or a request without its scenario, stays in `skipped` like
  any other unverified case. A media scenario that does run has to dispatch a request
  carrying a file part of that media class — `application/pdf` for `document`, an `image/*`
  type for `image` — and come back complete, so a text-only request fails it rather than
  passing it.
- b7c7107: Requests can now carry documents and images alongside text. An operation's `prompt` may
  return an array of content parts — `{ type: 'text', text }` and `{ type: 'file', mediaType,
data, filename? }`, with `data` as base64 and `mediaType` one of `application/pdf`,
  `image/jpeg`, `image/png`, `image/webp` or `image/gif` — instead of a string. Returning a
  string still works and is unchanged: it normalizes to a single text part, so every existing
  operation runs as it did. Parts are validated and frozen before a quota slot is reserved: a
  malformed part raises a `TypeError`, and file payload over 15,000,000 base64 characters
  raises a `RangeError`, neither of which ever names your file's bytes or filename.

  **Breaking for custom `Provider` implementations.** `ProviderRequest.prompt: string` is
  replaced by `ProviderRequest.parts: readonly ContentPart[]`. An adapter that read
  `req.prompt` reads the text of the single text part instead. The built-in Anthropic,
  OpenAI-compatible and Gemini adapters send exactly the body they sent before for a
  text-only request.

## 0.1.1

### Patch Changes

- Documentation only. The readme is shorter and leads on the package being model
  agnostic, the full reference moved to `docs/guide.md`, and the prose across the
  spec, runbook and code comments is plainer. No runtime code changed.

## 0.1.0

### Patch Changes

- e5ef94e: Docs: the README quickstart is now self-contained and mechanically verified: its
  TypeScript fence is compiled straight out of the README against both the spec and the
  built package, and executed in a clean directory against a packed tarball in CI. New
  generated per-adapter wire reference at `docs/providers.md` (built verbatim from spec §5c,
  drift-gated, shipped in the npm package). Every markdown link and anchor is now checked in
  CI. Error-sanitization wording in README and SECURITY scoped to package-owned fields, with
  the pre-dispatch `cause` pass-through disclosed.
- 2f6e1d9: Docs: the README's Contributing section now points at the security policy, since security
  problems go through GitHub's private vulnerability reporting, described in `SECURITY.md`,
  rather than an issue or a pull request.
- ee1bcb9: Docs: the README now links two runnable examples: `examples/next` (TypeScript, App
  Router) and `examples/express` (plain JavaScript), each a self-contained project that
  installs the packed tarball and runs one operation end to end, and each verified that way
  in CI against a local fixture provider rather than a live key. The Quickstart also notes
  that any package manager works.

Notable changes to this package, in the style of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are generated from
changesets when a release is prepared, so nothing is written here by hand.

While the package is on `0.x`, a breaking change bumps the **minor** version. See the
semantic-versioning note in `docs/spec.md`.

Nothing has been released yet.
