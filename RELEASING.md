# Releasing

How a version of this package reaches npm. Written so that whoever does it next — including
me, six months from now — does not have to work out the reasoning again.

A release is staged before it is published. The workflow builds the bytes, audits them and
hands them to the registry as a _staged_ version: reserved, downloadable by a maintainer,
and installable by nobody. The same bytes are then downloaded, verified, and promoted by
hand behind a 2FA challenge. That split is the point of this document — what gets verified
is what gets published, because there is only ever one tarball.

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
- The machine you will run the staged-publishing steps from has npm 11.15 or newer and
  Node 22.14 or newer. Both floors are hard: the `npm stage` subcommands do not exist
  below them, and downloading a staged tarball has no web equivalent to fall back on.
  Check with `npm --version` and `node --version`, and upgrade before you start rather
  than in the middle of a half-published release.

### Release verification

The workflow does not cover all of it. Two checks run by hand, and a release ships only if
both pass:

```bash
( cd <checkout>; node scripts/verify-release.mjs ~/release-<version>/<tarball> )
( cd <checkout>; node scripts/live-check-providers.mjs --release ~/release-<version>/<tarball> )
```

**Where they run from:** both are scripts in this repository, so they need a checkout of it —
the directory the tarball sits in holds nothing but the tarball and its hashes. The
subshells are what keep that a detour: the shell you are working in stays where it was, and
the tarball is passed across by path.

That checkout must be at the commit being released and clean — `git status --porcelain`
prints nothing — because the scripts and the helpers they import come out of it: an edited
harness verifies something other than the release. What comes from the tarball is the package
under test, which each script installs into a scratch project and exercises from there.

The first installs that tarball into a scratch project, applies the packaged SQL to a real
PostgreSQL and runs all three conformance suites from the installed package — not from the
working tree, so what is verified is what adopters get. It needs `DATABASE_URL` pointing at
a throwaway database on this machine; `CONTRIBUTING.md` has the shape it accepts and the
script's own header has a container to run it against.

The second exercises every built-in adapter against its real provider endpoint, which is
what the specification leans on for the pinned wire contracts. It needs live keys, so it is
run by hand and never in continuous integration; in the `--release` form above a missing key
is a failure rather than a skip. Use throwaway keys and revoke them when you stop, not only
when you finish.

**When they run:** on the staged tarball, after the workflow has staged the release and
before you approve it — that is the only moment the bytes are both final and not yet
installable by anyone. The release candidate in the bootstrap below is verified the same
way, on the audited artifact, before it is published from a laptop.

## How a release runs

Dispatch the `publish` workflow from the Actions tab with `expected_sha` set to the reviewed
commit. Nothing about a release is automatic: the workflow is manual only, and it stops at
staging.

1. The `audit` job checks it is running on `main` at exactly that SHA, builds, packs, records
   the tarball's SHA-256 and SHA-512, audits what the tarball contains, installs it into ESM,
   CommonJS and TypeScript projects on the lowest supported Node, and uploads the tarball and
   both hash files as the `release-tarball` artifact. This job holds no credentials. Two
   digests because two different things consume them: the staged bytes are compared by
   SHA-256, and a provenance attestation names its subject by SHA-512.
2. The `publish` job waits behind the `release` environment's approval. That gate sits after
   the audit and immediately before the registry changes, so the thing being approved is a
   set of bytes somebody can already look at.
3. The staging step rechecks the recorded hash and runs `npm stage publish` on the file that
   hash record names, in the same step, so there is no window between verifying the bytes and
   sending them. It authenticates over OIDC and carries no token. A staged version is
   reserved and downloadable, and `npm install` cannot reach it. The stage also records the
   dist-tag the version will take — `latest`, since the step passes no `--tag` — and that tag
   is applied when the stage is approved rather than now. That is what a stable release
   wants. A prerelease is a different matter: npm refuses to stage one under the default tag
   at all, so staging a prerelease through this workflow would mean adding `--tag` to the
   staging step.
4. Download the run's `release-tarball` artifact from the Actions run page and unpack it into
   a directory of its own. It holds the packed tarball and both hash files, and later steps
   read `tarball.sha256` and `tarball.sha512` out of it:

   ```bash
   mkdir -p ~/release-<version> && cd ~/release-<version>
   unzip ~/Downloads/release-tarball.zip
   ```

   Work from this directory for the rest of the flow, and keep it outside any checkout of
   this repository: the scratch install in step 10 needs a directory that is nobody's
   subdirectory. The two verification commands are the exception — they are scripts in this
   repository, so they run from a checkout at the released commit with the tarball passed by
   path, as _Release verification_ shows.

5. Open a temporary authenticated session (see below) and capture the stage identifier from
   the workflow run. Then confirm it against the registry, and confirm it is the only one:

   ```bash
   npm stage list llmswitch
   ```

   Exactly one stage for the version being released. If there is another — an abandoned
   attempt, most likely — reject it before going on, so that "the stage" means one thing for
   the rest of these steps. Every `npm stage` subcommand needs authenticated maintainer
   access; OIDC can only stage.

6. Wait for the stage to finish validating: `npm stage view <stage-id>`, or read the state off
   the listing above. npm scans staged bytes like any other upload, and a stage it has not
   finished with can be neither downloaded nor approved. At the time of writing the CLI
   reports that condition as `validating`; wait for it to report the stage as ready. A stage
   that ends in a failed or rejected state is not something to retry into — reject it and
   find out why, as in the mismatch branch below. The exact state names, like the `shasum`
   field that branch reads, are worth confirming here on the first staged release, before
   anything depends on them.
7. Download it with `npm stage download <stage-id>`. This is the step with no web equivalent,
   and the reason for the CLI floors above; the Staged Packages tab is a fallback for reading
   the stage identifier and for the approval, never for this. The file arrives named for the
   stage, as `llmswitch-<version>-<stage-id>.tgz`, so it does not collide with the artifact
   you unpacked in step 4.
8. Verify those exact bytes. Because the download carries the stage identifier in its name,
   `sha256sum -c tarball.sha256` would check the artifact sitting beside it and pass while
   telling you nothing. Compare values instead:

   ```bash
   sha256sum llmswitch-<version>-<stage-id>.tgz
   cut -d' ' -f1 tarball.sha256
   ```

   The two hashes must be identical. Then run both commands from _Release verification_,
   giving each the full path to the file you just downloaded; in the subshell form shown
   there, they leave you in this directory. If the hashes differ, this is not a retry and not a rebuild: the
   registry is holding bytes that were never audited. Do not approve. Reject the stage, and
   treat it as a security incident — audit the account, its tokens and the workflow before
   anything is dispatched again.

9. Approve the stage you just downloaded and verified — the same identifier, not the newest
   one on the listing:

   ```bash
   npm stage approve <stage-id>
   ```

   npm answers with a 2FA challenge. If none appears, **stop** — the credential in play is
   not the one this process assumes. Approval promotes the same registry-held bytes; nothing
   is rebuilt and nothing is re-uploaded. Staged versions carry provenance exactly as direct
   publishes do. The version is installable from this moment, under the tag the stage
   recorded, so everything below happens on a live release.

10. Prove what landed. Read the expected digest before moving, then install into a scratch
    project of its own, with its own user config so neither this machine's settings nor the
    session's credential take part:

    ```bash
    cd ~/release-<version>
    expected="$(cut -d' ' -f1 tarball.sha512)"
    mkdir release-check && cd release-check
    npm init -y > /dev/null
    npm install llmswitch@<version> --userconfig "$PWD/npm-scratch" \
      --registry=https://registry.npmjs.org/
    npm audit signatures --json --include-attestations --userconfig "$PWD/npm-scratch" \
      --registry=https://registry.npmjs.org/ > signatures.json
    ```

    `npm init -y` is what makes the directory its own project root rather than part of
    whatever encloses it, and `npm audit signatures` audits the installation it is run in, so
    anywhere else audits the wrong tree. The `--json --include-attestations` form is the one
    that answers the question: the plain command prints counts and does not fail on a package
    that has no attestation at all.

    What lands in `signatures.json` is `invalid`, `missing`, and a `verified` list. There must
    be an entry there for `llmswitch`; no entry is itself the failure. Its attestations are
    Sigstore bundles, so the readable part is base64 inside each one and has to be decoded:

    ```bash
    node -e "
    const report = require('./signatures.json')
    const entry = (report.verified || []).find((p) => p.name === 'llmswitch')
    if (!entry) throw new Error('no verified attestation for llmswitch')
    for (const { predicateType, bundle } of entry.attestationBundles) {
      const payload = bundle.dsseEnvelope.payload
      const statement = JSON.parse(Buffer.from(payload, 'base64').toString())
      console.log(predicateType, JSON.stringify(statement, null, 2))
    }
    "
    ```

    Two statements print: the publish attestation, and the provenance one, whose
    `predicateType` names SLSA provenance. In the provenance statement,
    `subject[0].digest.sha512` is the subject digest — it must equal `$expected` — and
    `subject[0].name` is the package and version it was signed for. The rest sits under
    `predicate`: `buildDefinition.externalParameters.workflow` carries the repository, the
    workflow file and the ref, `buildDefinition.resolvedDependencies[0].digest.gitCommit` the
    commit, and `runDetails.metadata.invocationId` the run. Read all of them against what you
    dispatched. These names follow the predicate version npm emits, so confirm them against
    what actually prints on the first release rather than trusting the list.

    Then, separately, check the bytes on offer to installers:

    ```bash
    npm view llmswitch@<version> dist.integrity --registry=https://registry.npmjs.org/
    ```

    That prints `sha512-` and the registry's digest for the tarball in base64; decode it with
    `node -p "Buffer.from('<base64>', 'base64').toString('hex')"` and compare with
    `$expected`. It is a different question from the attestation — what installers receive,
    rather than what the registry attests about where it came from — and both must answer
    the same digest.

    A missing attestation, a missing entry, or a digest that does not match is an incident on
    a version that is already installable. Deprecate it while you investigate —
    `npm deprecate llmswitch@<version> "under investigation"` — rather than leaving it
    recommended to everyone, and do not go on to step 11.

11. Settle the dist-tags. Approval already applied `latest`, so the only question left is
    whether a stale tag is pointing somewhere it should not. Read them first:

    ```bash
    npm dist-tag ls llmswitch
    ```

    In practice only the bootstrap leaves anything to do here, because the release candidate
    is what puts `next` on the package. If `next` is present, either move it —
    `npm dist-tag add llmswitch@<version> next` — or remove it —
    `npm dist-tag rm llmswitch next` — and read the tags back. If it is absent, there is
    nothing to move and nothing to add. Then close the session.

Consult `npm stage --help` for exact subcommand syntax at the time you run it: staged
publishing is newer than most guides.

The workflow also takes an `audit_only` input. With it set, the publish job never becomes
eligible at all, so nothing is staged: the run produces the audited `release-tarball`
artifact and stops. Use it whenever you want the exact audited bytes without leaving a run
parked one approval away from the registry. However you dispatch it, look at the run
afterwards and confirm the publish job shows as skipped — that check costs seconds and does
not depend on how the input was delivered.

### Temporary authenticated sessions

Two steps in this document need a logged-in npm CLI: the bootstrap release candidate, and
the staged download, approval and dist-tags of a stable release. Both use a session that
exists only for that stretch of work.

```bash
export NPM_CONFIG_USERCONFIG="$PWD/npm-session"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
npm login
npm whoami
# ... the work ...
npm token list
npm logout
rm -f "$NPM_CONFIG_USERCONFIG"
```

Every npm command in that shell inherits both settings, which is the point: the commands in
this document that belong to a session carry no `--userconfig` or `--registry` of their own,
and a command that needs different settings — the scratch install in step 10 — overrides them
on its own command line. The path is absolute so that changing directory mid-task cannot
strand the credential in a file nobody deletes.

The separate user config keeps the credential out of `~/.npmrc`, where it would outlive the
task by default. `npm whoami` is an identity check, not a formality — it says which account
the following commands will act as, and the registry is pinned for the same reason it is
pinned everywhere else here: a configured mirror would otherwise answer instead.

Close the session in that order. `npm token list` needs the credential, so it comes before
the logout, not after: read it while you still can and revoke anything with write or bypass
capability that you cannot account for. Then log out, which revokes the session server-side,
and delete the file, which removes what is left locally. No automation token is created for
any of this.

### What each step proves

- The workflow's successful **stage** proves the trusted-publisher binding works: npm accepted
  an OIDC credential naming this repository, this workflow and this environment. That the job
  used no token is a separate claim, and a different mechanism proves it — the workflow file
  passes no credential to the step, and the repository's secrets list holds none for it. Read
  both; a successful stage cannot tell you that.
- The **approval** proves owner presence: it is interactive, it is answered with 2FA, and it
  cannot be done by the workflow.

They are separate claims about separate steps. A stage that succeeded says nothing about the
approval, and an approval says nothing about how the bytes got there.

### When something fails

Everything here turns on one question: has the stage been approved yet. Before approval the
version exists only as a stage — it reserves its number while being invisible to a plain
`npm view`, so "nothing is on the registry" is not evidence of anything, and anything wrong
with it is undone by rejecting it. After approval the version is live and cannot be rejected,
withdrawn or replaced; the remedy there is to deprecate it while you investigate. Work out
which side of that line you are on before you type anything.

**The workflow run failed and the stage state is unknown.** Inspect `npm stage list` and
`npm stage view` from a temporary authenticated session, which is also what pins the registry
for the commands below. What a stage listing shows of the bytes is a `shasum`, which is a
SHA-1 — the legacy field, and the only digest on offer there — so compare it against
`sha1sum` of the tarball in the run's artifact rather than against either recorded hash. The
release candidate never stages, since it is published from a laptop, so the first chance to
confirm this reading is steps 5 and 6 of the first staged release: read the fields there,
before this branch depends on them.

- No stage — fix the cause and dispatch again.
- A stage whose `shasum` matches the artifact's `sha1sum` — the send succeeded and something
  after it did not. Carry on with verification of that stage, whose full check is step 8.
- A stage whose `shasum` does not match, or one left in a failed validation state — reject it
  with `npm stage reject <stage-id>` and find out where those bytes came from before doing
  anything else.

**You issued an approval and do not know whether it promoted.** Query the version on the
pinned public registry.

- Absent — re-check the stage and approve again.
- Present, digest matches, provenance as expected — it worked; reconcile and carry on.
- Present with a different digest, or with no provenance — treat it as a security incident.
  The version is live and cannot be taken back, so deprecate it with a message saying it is
  under investigation, then stop: audit the account, its tokens and the workflow, and do not
  retry.

Three more, none of which is a retry:

- **A verification command fails before approval.** The release is blocked and the gate did
  what it is for. Do not approve the stage — reject it with `npm stage reject <stage-id>`,
  because a stage left standing still holds that version number while being invisible to
  `npm view`, and the next dispatch would collide with your own abandoned attempt. Revoke the
  provider keys before you put it down.
- **Something is wrong after approval** — a missing attestation, a digest that does not match,
  anything the step-10 checks turn up. There is no stage left to reject: deprecate the
  version with a message saying so while you investigate, and treat a digest or provenance
  discrepancy as a security incident rather than a bookkeeping error.
- **The package page shows a scan flag.** Triage before appealing: diff the exact tarball,
  look at its dependencies and provenance, audit the account and its tokens. An appeal is
  worth making only with evidence that the flag is wrong, and nothing publishes until the
  page is healthy.

If you stop for any reason once a release candidate exists, say explicitly what happens to
the `next` tag — kept, with a reason, or removed — rather than leaving it pointing at
whatever it happened to point at.

## Every release after the first

The flow above, and nothing else. The workflow authenticates to npm over OIDC as the
configured trusted publisher, and no publish token exists in it at all.

## First release: bootstrapping the trusted publisher

npm will only let a trusted publisher be configured on a package that already exists, so the
very first version cannot go through the workflow. This section exists once. Follow it in
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

2. **Build a release candidate.** Set the version to `0.1.0-rc.0` — this one bump is an
   exception to the changesets rule above, because the RC is not a stable release: edit
   `version` in `package.json` and in `package-lock.json` (both the root entry and the
   self-referencing packages entry) by hand, and land it as its own reviewed commit. Run the
   workflow at that commit with `audit_only`, download the `release-tarball` artifact, and
   check its hash locally with `sha256sum -c tarball.sha256`.

3. **Verify it**, with both commands from _Release verification_, against that tarball.
   Nothing is published until both pass.

4. **Publish the release candidate** from your own terminal, in a temporary authenticated
   session, as that exact tarball:

   ```bash
   npm publish ./llmswitch-0.1.0-rc.0.tgz --tag=next --access=public --ignore-scripts
   ```

   You must be presented with a 2FA challenge. If none appears, **stop** and find out why
   before republishing — an unchallenged publish means the credential in play is not the one
   this process assumes. The `next` tag keeps the version that bootstraps the registry entry
   out of what a plain `npm install` gets.

   Close the session afterwards as _Temporary authenticated sessions_ describes, token audit
   included.

5. **Wait.** npm scans a fresh publish before the package page and its settings are usable.
   Allow minutes, not seconds — often around five, sometimes fifteen or more. Poll rather
   than assume, and read what the page says: pending is not the same as rejected.

6. **Configure the trusted publisher**, interactively, on the package's settings. The binding
   is data — copy it character for character:

   | Field             | Value               |
   | ----------------- | ------------------- |
   | GitHub owner      | `parvezrob`         |
   | Repository        | `llmswitch`         |
   | Workflow filename | `publish.yml`       |
   | Environment       | `release`           |
   | Allowed action    | `npm stage publish` |

   The workflow field is a filename, not a path. The environment name is case-sensitive. A
   package gets one trusted publisher, so there is no second entry to fall back on. npm does
   not validate any of these fields when you save them — a mismatch first shows up as a
   failed stage, which is why they are copied rather than typed from memory. The allowed
   action is the whole point of the arrangement: the workflow may stage a version and may
   not publish one, so the automated half of a release can never reach an installable
   version on its own.

7. **Restrict the package**: require 2FA, and disallow publishing with a token. Do this now,
   before the first stable release rather than after it. It is safe at this point precisely
   because the flow is split — the workflow stages over OIDC, which the restriction does not
   touch, and the promotion is the interactive, 2FA-answered step the restriction is meant to
   enforce. Leaving it until the end would mean the one release that matters most is the one
   published under the looser rules. Confirm on the settings page that turning the
   restriction on left the trusted publisher in place and enabled.

8. **Preflight.** `repository.url` in `package.json` names this repository exactly, and the
   trusted-publisher list shows the single entry above and nothing else.

9. **Restore the real version**, as its own reviewed commit. `npx changeset version` run
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

10. **Release `0.1.0` through the workflow**, exactly as _How a release runs_ describes:
    dispatch, approve the environment, stage, download, verify, approve under 2FA. This
    release is the first evidence the OIDC binding works and the first build to carry
    provenance naming the repository, the workflow and the run.

11. **Clean up the `next` tag**, as step 11 of that flow. Approving the stage applied `latest`
    to `0.1.0`; `next` is still on the RC until you move it —
    `npm dist-tag add llmswitch@0.1.0 next` — or remove it —
    `npm dist-tag rm llmswitch next`. Read the result back with
    `npm dist-tag ls llmswitch` and check both tags say what you intended. These commands run
    in the same authenticated session as the approval, which is what pins the registry for
    them; a configured mirror would otherwise take them silently.

    This is the last thing that session is for. Close it as _Temporary authenticated
    sessions_ describes — token audit, logout, delete the user config. The bootstrap is not
    finished while a credential is still sitting on disk.

No granular access token with Bypass 2FA is used at any point. Besides being one more
credential to protect, npm has said such tokens lose their direct-publish capability around
January 2027, so a release process built on one would have to be rebuilt.

Stable releases carry provenance. The bootstrap RC does not — a publish from a laptop has
nothing to attest with.
