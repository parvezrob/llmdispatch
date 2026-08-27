# Contributing

Thanks for looking. This package is pre-release: the design in [`docs/spec.md`](docs/spec.md)
is settled and the implementation is being written against it. If you are thinking of a
change, open an issue first. It is a short conversation, and it saves you from writing
code against a contract that says something different.

## Getting set up

```bash
npm ci
npm run check
```

`npm run check` is the whole local pass: formatting, lint, types (the compile fixtures
included), module boundaries, the build, then the subset of those fixtures whose imports
already exist in the build compiled against it (the rest join as the remaining exports land),
the export inventory comparing `dist/` with the specification, package
linting, package typing, the public type surface, the size budget, and the unit tests with
coverage. If it is green, continuous integration will almost certainly agree, since it runs the
same thing plus a few checks that need a database, a second Node, or a network download.

Node 24.19.0 is the development version (`.nvmrc`); the package supports Node 20 and up,
and the tests are run there too.

## The rules the tooling enforces

Nothing below is a matter of taste. Each one has a check behind it, so you will find out
from `npm run check` rather than from a comment on your pull request.

**Types.** `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No
`any` anywhere: the lint rule is an error, not a warning. No non-null assertions outside
tests. Type-only imports are written as such.

**Module boundaries.** The folders in `src/` are a dependency order, not a filing system;
[`docs/architecture.md`](docs/architecture.md) draws it and `npm run depcruise` enforces
it. The short version: `types.ts` is the floor and imports nothing but Zod, `errors` depends
on nothing else, `core` decides and performs no I/O, `providers` and `stores` adapt one thing
each, `conformance` only ever sees interfaces, and the entry modules assemble. Each folder
has a `README.md` restating its own rule.

**Dependencies.** The published package has none. Zod is a peer dependency the adopter
already has; anything else would be an install they did not ask for. Development
dependencies are fine, and the lockfile is read as carefully as source.

**The published surface.** `api/*.d.ts` is a checked-in copy of what the package exports.
If your change alters it, run `npm run api:update` and commit the result: that diff is
where a change to the published surface becomes visible, and it is the part of a pull
request worth reading first. From the first release onward, such a change also needs a
changeset (`npx changeset`).

**The specification is the surface.** `test/types/spec-surface*.d.ts` are generated from the
§6 and §6b code fences of [`docs/spec.md`](docs/spec.md): edit the spec, run `npm run
surface:update`, never edit them by hand. `check-spec-surface.mjs` compares every name
`dist/` exports, both module systems and type told from value, with what the spec declares. A
spec name the implementation has not reached yet is listed in `test/types/spec-pending.json`;
a name on that list which has appeared in `dist/` fails as loudly as one that is missing.

**Compile fixtures.** `test/types/positive/` must compile with no diagnostic at all, the
README's examples among them, and `test/types/negative/` holds the shapes the README
promises will not compile. `check-types-fixtures.mjs` compiles each in a program of its own:

- line one is `// @targets spec[, package]`; every fixture targets `spec`, and gains
  `package` once every value it imports exists in `dist/`.
- a negative fixture carries `// @expect TS####` on the line above the offending one and must
  produce exactly that: "something went wrong" is not evidence.
- no suppression and no `any`, since either would let a fixture compile proving nothing.
- `test/types/scaffold.d.ts` declares the values the README examples use without introducing
  them, so those examples compile as printed.

**Errors.** Two public classes. `LLMDispatchError` has a closed set of codes and a `retryable`
flag copied from the classification row in spec §5b rather than worked out on the spot. The
flag belongs to the row and not to the code: `PROVIDER_FAILED` is retryable for a
`transient` failure and not for a `refused` one, which is why `src/errors` has one factory
per classification, and why nothing is ever constructed by hand. `ProviderError` is what a
provider adapter throws, and it is recognised with `ProviderError.is()`, never bare
`instanceof`, which breaks the moment ESM and CommonJS copies meet. Messages never contain a
prompt, a model's output, or a raw provider error.

**Tests.** Vitest. Unit tests run everywhere; the ones that need PostgreSQL live in
`test/integration` and read `DATABASE_URL`. They are skipped when it is unset, except in
continuous integration, where a missing database is a failure rather than a quiet pass. The
version they are written against is the one CI runs:

```bash
docker run -d --name llmdispatch-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres \
  postgres:14@sha256:2fdfb9b432d4a73bd3eea3d989752c1e669b68d502347e0bfd2cc6d709f3d6b4
until docker exec llmdispatch-pg pg_isready -U postgres; do sleep 1; done
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:integration
docker rm -f llmdispatch-pg
```

`src/core` and `src/errors` are held at 90%
lines and branches. A test name should read as a sentence about behaviour, and each test
should be about one behaviour.

**Style.** Prettier decides formatting, so it is never worth discussing. Full words over
abbreviations; functions are verbs, types are nouns, booleans read as predicates. A
comment explains why, not what. Where a decision comes from the specification, cite the
section.

## Commands

| Command                                                  | What it does                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run check`                                          | everything below that does not need a database or the network                |
| `npm run build`                                          | the dual ESM + CommonJS build into `dist/`                                   |
| `npm test`                                               | unit tests                                                                   |
| `npm run test:coverage`                                  | unit tests with the coverage thresholds applied                              |
| `npm run test:integration`                               | tests that need `DATABASE_URL`                                               |
| `npm run depcruise`                                      | module boundaries                                                            |
| `npm run api:check` / `api:update`                       | compare or record the public type surface                                    |
| `npm run surface:update`                                 | regenerate the spec surfaces after editing `docs/spec.md`                    |
| `node scripts/check-spec-surface.mjs`                    | compare what `dist/` exports with what the spec declares                     |
| `node scripts/check-types-fixtures.mjs --target spec`    | compile the type fixtures against the spec surfaces                          |
| `node scripts/check-types-fixtures.mjs --target package` | the fixtures the build can satisfy, against it                               |
| `npm run size`                                           | gzipped size of the root entry against `sizeBudget`                          |
| `npm run scan`                                           | scan the tree for addresses, unreviewed links and key-shaped strings         |
| `npm run docs:providers`                                 | regenerate `docs/providers.md` from spec §5c                                 |
| `node scripts/build-provider-reference.mjs --check`      | fail if `docs/providers.md` no longer matches spec §5c                       |
| `node scripts/check-docs-links.mjs`                      | every markdown link and anchor resolves                                      |
| `node scripts/verify-quickstart.mjs [tgz]`               | follow the README quickstart in a clean directory (needs network)            |
| `node scripts/verify-examples.mjs [tgz]`                 | run both `examples/` end to end against that tarball (needs network)         |
| `npm run audit:tarball -- <tgz>`                         | what a packed tarball contains and whether it would run anything             |
| `npm run test:consumers -- <tgz>`                        | install that tarball into ESM, CommonJS and TypeScript projects              |
| `npm run verify:release -- <tgz>`                        | install that tarball and run all three suites against a throwaway PostgreSQL |
| `npm run live:providers`                                 | call every built-in adapter's real provider (needs your own keys)            |

Everything that takes a tarball takes one you produced with `npm pack`; they never pack one
themselves, so what you audit is what you test.

`verify:release` needs `DATABASE_URL` pointing at a throwaway database on this machine. It
creates a schema, writes to it and drops it, so it takes exactly one shape,
`postgres://user:password@127.0.0.1:port/database`: an address in 127.0.0.0/8, a port written
out, and no query string or fragment. The header of `scripts/verify-release.mjs` has a
container to run it against.

`live:providers` spends money and depends on three services being up, so it is never part of
`npm run check` and never runs in continuous integration. Each provider is called in a process
of its own holding only that provider's key; use throwaway keys and revoke them afterwards. Run
`npm run live:providers -- --release <tgz>` to check a packed tarball rather than your working
tree, since that form requires every adapter to run, so a missing key is a failure instead of a
skip. (The `--` is what stops npm from eating the arguments.)

## How changes land

**Commit messages follow Conventional Commits**: `feat:`, `fix:`, `docs:`, and the rest.
That is the convention the history is written in; the changelog itself is generated from
changesets, not from commit messages, so the prefix is for the reader of `git log`.

**A pull request lands rebased**, as a small set of coherent commits with the fixups squashed
away before the final review. The history is linear and there are no merge commits, so
`git log` reads as the order things actually happened.

**Never a live API key**: not in a pull request, not in a fixture, not in continuous
integration. Fixtures are synthetic, or recorded from a real response and then redacted; CI
runs without provider keys by construction rather than by anyone remembering. `npm run scan`
is part of reviewing a change, and secret hygiene is checked before anything is pushed, not
after.

Getting a version out is a separate procedure with its own preconditions:
[`RELEASING.md`](RELEASING.md).

## Pull requests

One coherent change per pull request, with the checks green. Explain what the change does
and why in the description, because the commit history is the project's memory. If the change is
visible to users of the package, say so in a changeset.

Security problems do not go in a pull request: see [`SECURITY.md`](SECURITY.md).
