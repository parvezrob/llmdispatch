# Changelog

## 0.1.0

### Patch Changes

- e5ef94e: Docs: the README quickstart is now self-contained and mechanically verified — its
  TypeScript fence is compiled straight out of the README against both the spec and the
  built package, and executed in a clean directory against a packed tarball in CI. New
  generated per-adapter wire reference at `docs/providers.md` (built verbatim from spec §5c,
  drift-gated, shipped in the npm package). Every markdown link and anchor is now checked in
  CI. Error-sanitization wording in README and SECURITY scoped to package-owned fields, with
  the pre-dispatch `cause` pass-through disclosed.
- 2f6e1d9: Docs: the README's Contributing section now points at the security policy — security
  problems go through GitHub's private vulnerability reporting, described in `SECURITY.md`,
  rather than an issue or a pull request.
- ee1bcb9: Docs: the README now links two runnable examples — `examples/next` (TypeScript, App
  Router) and `examples/express` (plain JavaScript) — each a self-contained project that
  installs the packed tarball and runs one operation end to end, and each verified that way
  in CI against a local fixture provider rather than a live key. The Quickstart also notes
  that any package manager works.

Notable changes to this package, in the style of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are generated from
changesets when a release is prepared, so nothing is written here by hand.

While the package is on `0.x`, a breaking change bumps the **minor** version — see the
semantic-versioning note in `docs/spec.md`.

Nothing has been released yet.
