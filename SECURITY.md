# Security

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. That opens a private
thread visible only to the maintainers, and it lets a fix and an advisory be prepared
together.

Please do not open a public issue or a pull request for a security problem.

Tell me what you can: what you did, what happened, which version you were on, and what an
attacker gets out of it. A proof of concept is welcome and never required. I will
acknowledge the report, say whether it is something I can fix, and keep you updated while
a fix is prepared. If you would like credit in the advisory, say so.

## Supported versions

While the package is on `0.x`, only the most recent release gets fixes. Once there is a
`1.0`, this section will say something more useful.

## What the package promises about your data

These are properties of the design, described in full in
[`docs/spec.md`](docs/spec.md). They are worth knowing when you assess your own exposure.

**Credentials stay in your process.** Provider credentials are supplied in code, as
functions that return them when a request is about to be made. They are never read from
runtime configuration, never written to the database, and never part of what an
administrator can edit at runtime. Changing a route changes a provider and a model, never
a credential or an endpoint.

**Prompts and outputs are never persisted.** What the stores hold is the operation name,
the subject identifier you passed, a UTC day, reservation state, timestamps, and per
attempt the provider, model, outcome, status, token counts, cost and duration. Not the
prompt, not the input, not the model's output, not a raw provider error.

**The error type's package-owned fields are sanitised.** The error raised by a failed
run carries a code, a retryable flag, and attempt records; those fields do not carry
prompt text, model output, or the provider's raw error body from a dispatched attempt.
One deliberate pass-through: a pre-dispatch error may chain the underlying store or
`prepare()` failure as `cause`, verbatim, so treat that `cause` as unsanitised.

**Requests are not redirected.** Every built-in adapter sends its request with redirects
disabled, so a credential or a prompt is never replayed to a host you did not configure. A
redirect is treated as a transient failure.

**Nothing runs at install time.** The package declares no lifecycle scripts of any kind
and no runtime dependencies, and the build is configured to publish source maps beside
the code once there is code to map. Continuous integration inspects the packed tarball on
every change and fails if any of that stops being true.

**Your database schema is yours.** The PostgreSQL migrations are shipped as SQL with a
checksum for you to apply. The package never runs data-definition statements against your
database on its own.
