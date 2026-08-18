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

`npm run check` is the whole local pass: formatting, lint, types — the compile fixtures
included — module boundaries, the build, then the subset of those fixtures whose imports
already exist in the build compiled against it (5 of 13 today; the rest join as the remaining
exports land), the export inventory comparing `dist/` with the specification, package
linting, package typing, the public type surface, the size budget, and the unit tests with
coverage. If it is green, continuous integration will almost certainly agree — it runs the
same thing plus a few checks that need a database, a second Node, or a network download.

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
`dist/` exports — both module systems, type told from value — with what the spec declares. A
spec name the implementation has not reached yet is listed in `test/types/spec-pending.json`;
a name on that list which has appeared in `dist/` fails as loudly as one that is missing.

**Compile fixtures.** `test/types/positive/` must compile with no diagnostic at all — the
README's examples among them — and `test/types/negative/` holds the shapes the README
promises will not compile. `check-types-fixtures.mjs` compiles each in a program of its own:

- line one is `// @targets spec[, package]`; every fixture targets `spec`, and gains
  `package` once every value it imports exists in `dist/`.
- a negative fixture carries `// @expect TS####` on the line above the offending one and must
  produce exactly that: "something went wrong" is not evidence.
- no suppression and no `any` — either would let a fixture compile proving nothing.
- `test/types/scaffold.d.ts` declares the values the README examples use without introducing
  them, so those examples compile as printed.

**Errors.** Two public classes. `LLMSwitchError` has a closed set of codes and a `retryable`
flag copied from the classification row in spec §5b rather than worked out on the spot. The
flag belongs to the row and not to the code — `PROVIDER_FAILED` is retryable for a
`transient` failure and not for a `refused` one — which is why `src/errors` has one factory
per classification, and why nothing is ever constructed by hand. `ProviderError` is what a
provider adapter throws, and it is recognised with `ProviderError.is()` — never bare
`instanceof`, which breaks the moment ESM and CommonJS copies meet. Messages never contain a
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

| Command                                                  | What it does                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm run check`                                          | everything below that does not need a database or the network        |
| `npm run build`                                          | the dual ESM + CommonJS build into `dist/`                           |
| `npm test`                                               | unit tests                                                           |
| `npm run test:coverage`                                  | unit tests with the coverage thresholds applied                      |
| `npm run test:integration`                               | tests that need `DATABASE_URL`                                       |
| `npm run depcruise`                                      | module boundaries                                                    |
| `npm run api:check` / `api:update`                       | compare or record the public type surface                            |
| `npm run surface:update`                                 | regenerate the spec surfaces after editing `docs/spec.md`            |
| `node scripts/check-spec-surface.mjs`                    | compare what `dist/` exports with what the spec declares             |
| `node scripts/check-types-fixtures.mjs --target spec`    | compile the type fixtures against the spec surfaces                  |
| `node scripts/check-types-fixtures.mjs --target package` | the fixtures the build can satisfy, against it                       |
| `npm run size`                                           | gzipped size of the root entry against `sizeBudget`                  |
| `npm run scan`                                           | scan the tree for addresses, unreviewed links and key-shaped strings |
| `npm run audit:tarball -- <tgz>`                         | what a packed tarball contains and whether it would run anything     |
| `npm run test:consumers -- <tgz>`                        | install that tarball into ESM, CommonJS and TypeScript projects      |

The last two take a tarball you produced with `npm pack`; they never pack one themselves,
so what you audit is what you test.

## Pull requests

One coherent change per pull request, with the checks green. Explain what the change does
and why in the description — the commit history is the project's memory. If the change is
visible to users of the package, say so in a changeset.

Security problems do not go in a pull request: see [`SECURITY.md`](SECURITY.md).
