# Releasing

How a version of this package reaches npm. Written so that whoever does it next — including
me, six months from now — does not have to work out the reasoning again.

## Before any release

- `main` is green: the full continuous-integration run on the exact commit being released.
- The version and the changelog were produced by changesets (`npx changeset version`), and
  that bump is its own reviewed commit on `main`.
- You have that commit's SHA in hand. The workflow refuses to run against anything else.
- The `release` environment is set to require a manual approval before its jobs run. That
  is a repository setting, and nothing in the repository can assert it: if the rule is
  missing, the environment stops being a gate and a dispatch runs straight through to the
  registry. Check it, do not assume it.
- No workflow other than `publish` selects the `release` environment. Another workflow
  naming it would sit behind the same approval and read the same environment-scoped
  secrets, which quietly widens what that one approval means.
- The npm account has 2FA enabled and its recovery codes are stored somewhere you can
  actually reach.

### Release verification

The dispatch workflow does not cover all of it. Two checks run before you dispatch, and a
release ships only if both pass:

- **Packaged migrations and conformance** (spec §6b, which mandates this). The packaged SQL
  is applied to a real PostgreSQL, and all three conformance harnesses run from the
  installed tarball — not from the working tree, so what is verified is what adopters get.
- **Provider live-check.** The built-in adapters are exercised against the real provider
  endpoints — the release live-check the specification leans on for the pinned wire
  contracts (§5c). It needs live keys, so it is run by hand and never in continuous
  integration.

How these are executed, and how much of either is worth automating, is settled with the
release audit. What is fixed here is that they are preconditions, not follow-ups.

## How a release runs

Dispatch the `publish` workflow from the Actions tab with `expected_sha` set to the reviewed
commit. Nothing about a release is automatic: the workflow is manual only.

1. The `audit` job checks it is running on `main` at exactly that SHA, builds, packs, records
   the tarball's SHA-256, audits what the tarball contains, installs it into ESM, CommonJS
   and TypeScript projects on the lowest supported Node, and uploads the tarball and its hash
   as the `release-tarball` artifact. This job holds no credentials.
2. The `publish` job waits behind the `release` environment's approval. That gate sits after
   the audit and immediately before the registry changes, so the thing being approved is a
   set of bytes somebody can already look at.
3. The publish step rechecks the recorded hash and publishes in the same step, so there is no
   window between verifying the bytes and sending them.

The workflow also takes an `audit_only` input. With it set, the publish job never becomes
eligible at all, and the run produces the audited `release-tarball` artifact and stops. Use
it whenever you want the exact audited bytes without leaving a run parked one approval away
from a publish. However you dispatch it, look at the run afterwards and confirm the publish
job shows as skipped — that check costs seconds and does not depend on how the input was
delivered.

## Every release after the first

The flow above, and nothing else. Once step 7 of the bootstrap below has landed, the workflow
authenticates to npm over OIDC as the configured trusted publisher and no publish token
exists in it at all.

## First release: bootstrapping the trusted publisher

npm will only let a trusted publisher be configured on a package that already exists, so the
very first publish cannot go through the workflow. This section exists once. Follow it in
order — several steps are ordered for a reason, noted where it matters.

1. **Recheck the name.** Immediately before publishing, confirm `llmswitch` is still
   unclaimed:

   ```bash
   npm view llmswitch --registry=https://registry.npmjs.org/
   ```

   It must fail with `E404`. The registry is named explicitly because a mirror or a corporate
   proxy will happily return `E404` for a name that is taken on the public registry. If the
   name has been claimed, **stop**. Moving to a scoped name is not a rename — the import
   specifier is the package's public contract, and it appears in the README, the type
   fixtures, the consumer tests, the examples and their lockfiles, and the verification
   harnesses. That is a migration with every release gate re-run, and it needs planning on
   its own.

2. **Publish a release candidate.** Set the version to `0.1.0-rc.0` — this one bump is an
   exception to the changesets rule above, because the RC is not a stable release: edit `version` in
   `package.json` and in `package-lock.json` (both the root entry and the self-referencing
   packages entry) by hand, and land it as its own reviewed commit. Run the workflow at that
   commit with `audit_only`, download the `release-tarball` artifact, and check its hash
   locally with `sha256sum -c tarball.sha256`.

   Publish that exact tarball from your own terminal. Start from a clean, interactive
   `npm login` against the public registry, then:

   ```bash
   npm publish ./llmswitch-0.1.0-rc.0.tgz --tag=next --access=public --ignore-scripts --registry=https://registry.npmjs.org/
   ```

   You must be presented with a 2FA challenge. If none appears, **stop** and find out why
   before republishing — an unchallenged publish means the credential in play is not the one
   this process assumes. The `next` tag keeps the version that bootstraps the registry entry
   out of what a plain `npm install` gets. No automation token is created for this, here or
   anywhere else in this document.

3. **Wait.** npm scans a fresh publish before the package page and its settings are usable.
   Allow minutes, not seconds.

4. **Configure the trusted publisher**, interactively, on the package's settings. The binding
   is data — copy it character for character:

   | Field             | Value         |
   | ----------------- | ------------- |
   | GitHub owner      | `parvezrob`   |
   | Repository        | `llmswitch`   |
   | Workflow filename | `publish.yml` |
   | Environment       | `release`     |
   | Allowed action    | `npm publish` |

   The workflow field is a filename, not a path. The environment name is case-sensitive. A
   package gets one trusted publisher, so there is no second entry to fall back on. npm does
   not validate any of these fields when you save them — a mismatch first shows up as a
   failed publish, which is why they are copied rather than typed from memory. The
   `npm trust` command can do this; it is newer than most guides, so check `npm trust --help`
   for the exact syntax at the time you run it, or use the package settings page.

5. **Preflight.** `repository.url` in `package.json` names this repository exactly, and the
   trusted-publisher list shows the single entry above and nothing else.

6. **Restore the real version**, as its own reviewed commit. `npx changeset version` run
   against `0.1.0-rc.0` consumes the pending patch changesets and lands on exactly `0.1.0` —
   a patch bump of a prerelease drops the prerelease rather than adding to it. Confirm that
   rather than trusting it; if the tool produces anything else, correct the version by hand
   in the same commit. The released version is `0.1.0`, not a `0.1.1` that a pending
   changeset produced by accident. Changesets edits `package.json` and the changelog but not
   the lockfile, so bring `package-lock.json` along by running
   `npm install --package-lock-only --ignore-scripts` — continuous integration checks the
   lockfile is canonical and will fail the commit otherwise.

   The same commit is where the pre-release prose goes, because changesets only ever inserts
   entries and never removes anything anybody wrote: drop the pre-release banner near the top
   of the README, and drop the "Nothing has been released yet." line from `CHANGELOG.md`.

   Review the whole result before merging, as with the RC bump: `package.json`,
   `package-lock.json`, `CHANGELOG.md`, and the changeset files the tool deleted.

7. **Remove `NODE_AUTH_TOKEN` from the publish workflow, and merge that before publishing
   through it.** npm falls back to token authentication when a token is in scope, so a
   publish with one still present proves nothing about the trusted-publisher binding.

8. **Publish `0.1.0` through the workflow.** This release is itself the first evidence the
   OIDC binding works, and it is the first build to carry provenance naming the repository,
   the workflow, and the run. Verify on the registry: the version, the tarball digest, and
   the provenance attestation.

9. **Point the dist-tags where they belong.** Publishing `0.1.0` does not touch `next`, which
   is still on the RC. Either move it —
   `npm dist-tag add llmswitch@0.1.0 next --registry=https://registry.npmjs.org/` — or remove
   it with `npm dist-tag rm llmswitch next --registry=https://registry.npmjs.org/`. Then read
   the result back with `npm dist-tag ls llmswitch --registry=https://registry.npmjs.org/`
   and check both `latest` and `next` say what you intended. The registry stays pinned for
   the same reason as everywhere else in this document: a configured mirror would otherwise
   take these commands silently.

10. **Restrict the package**: require 2FA, and disallow publishing with a token.

No granular access token with Bypass 2FA is used at any point. Besides being one more
credential to protect, npm has said such tokens lose their direct-publish capability around
January 2027, so a release process built on one would have to be rebuilt.

Stable releases carry provenance. The bootstrap RC does not — a publish from a laptop has
nothing to attest with.
