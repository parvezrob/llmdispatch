# Contributing

Thanks for looking. This package is pre-release: the design in [`docs/spec.md`](docs/spec.md)
is settled and the implementation is being written against it. If you are thinking of a
change, open an issue first — it is a short conversation, and it saves you from writing
code against a contract that says something different.

## Getting set up

```bash
npm ci
npm run check
```

`npm run check` is the whole local pass: formatting, lint, types, module boundaries, the
build, package linting, package typing, the public type surface, the size budget, and the
unit tests with coverage. If it is green, continuous integration will almost certainly
agree — it runs the same thing plus a few checks that need a database, a second Node, or
a network download.

Node 24.19.0 is the development version (`.nvmrc`); the package supports Node 20 and up,
and the tests are run there too.

## The rules the tooling enforces

Nothing below is a matter of taste. Each one has a check behind it, so you will find out
from `npm run check` rather than from a comment on your pull request.

**Types.** `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No
`any` anywhere — the lint rule is an error, not a warning. No non-null assertions outside
tests. Type-only imports are written as such.

**Module boundaries.** The folders in `src/` are a dependency order, not a filing system;
[`docs/architecture.md`](docs/architecture.md) draws it and `npm run depcruise` enforces
it. The short version: `errors` depends on nothing, `core` decides and performs no I/O,
`providers` and `stores` adapt one thing each, `conformance` only ever sees interfaces,
and the entry modules assemble. Each folder has a `README.md` restating its own rule.

**Dependencies.** The published package has none. Zod is a peer dependency the adopter
already has; anything else would be an install they did not ask for. Development
dependencies are fine, and the lockfile is read as carefully as source.

**The published surface.** `api/*.d.ts` is a checked-in copy of what the package exports.
If your change alters it, run `npm run api:update` and commit the result: that diff is
where a change to the published surface becomes visible, and it is the part of a pull
request worth reading first. From the first release onward, such a change also needs a
changeset (`npx changeset`).

**Errors.** One error class, a closed set of codes, and a `retryable` flag that is copied
from the classification table rather than worked out on the spot. Messages never contain a
prompt, a model's output, or a raw provider error.

**Tests.** Vitest. Unit tests run everywhere; the ones that need PostgreSQL live in
`test/integration` and read `DATABASE_URL`. `src/core` and `src/errors` are held at 90%
lines and branches. A test name should read as a sentence about behaviour, and each test
should be about one behaviour.

**Style.** Prettier decides formatting, so it is never worth discussing. Full words over
abbreviations; functions are verbs, types are nouns, booleans read as predicates. A
comment explains why, not what. Where a decision comes from the specification, cite the
section.

## Commands

| Command                            | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npm run check`                    | everything below that does not need a database or the network        |
| `npm run build`                    | the dual ESM + CommonJS build into `dist/`                           |
| `npm test`                         | unit tests                                                           |
| `npm run test:coverage`            | unit tests with the coverage thresholds applied                      |
| `npm run test:integration`         | tests that need `DATABASE_URL`                                       |
| `npm run depcruise`                | module boundaries                                                    |
| `npm run api:check` / `api:update` | compare or record the public type surface                            |
| `npm run size`                     | gzipped size of the root entry against `sizeBudget`                  |
| `npm run scan`                     | scan the tree for addresses, unreviewed links and key-shaped strings |
| `npm run audit:tarball -- <tgz>`   | what a packed tarball contains and whether it would run anything     |
| `npm run test:consumers -- <tgz>`  | install that tarball into ESM, CommonJS and TypeScript projects      |

The last two take a tarball you produced with `npm pack`; they never pack one themselves,
so what you audit is what you test.

## Pull requests

One coherent change per pull request, with the checks green. Explain what the change does
and why in the description — the commit history is the project's memory. If the change is
visible to users of the package, say so in a changeset.

Security problems do not go in a pull request: see [`SECURITY.md`](SECURITY.md).
