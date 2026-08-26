---
'llmswitch': patch
---

Docs: the README quickstart is now self-contained and mechanically verified — its
TypeScript fence is compiled straight out of the README against both the spec and the
built package, and executed in a clean directory against a packed tarball in CI. New
generated per-adapter wire reference at `docs/providers.md` (built verbatim from spec §5c,
drift-gated, shipped in the npm package). Every markdown link and anchor is now checked in
CI. Error-sanitization wording in README and SECURITY scoped to package-owned fields, with
the pre-dispatch `cause` pass-through disclosed.
