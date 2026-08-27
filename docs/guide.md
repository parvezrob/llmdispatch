# Guide

Everything llmdispatch does past the [README](../README.md) quickstart, in roughly the order you will need it. This is the working reference. The exact contract (state machine, store protocol, wire formats) is [spec.md](./spec.md).

## Input: documents and images

An operation's `prompt` returns a string, or an array of **content parts** when the call needs to carry a file. A `text` part is a string; a `file` part is base64 data plus the media type it is:

```ts
review: {
  input: z.object({ question: z.string(), invoice: z.string() }),  // invoice is base64
  prompt: ({ question, invoice }) => [
    { type: 'text', text: question },
    { type: 'file', mediaType: 'application/pdf', data: invoice, filename: 'invoice.pdf' },
  ],
}
```

The media types are `application/pdf`, `image/jpeg`, `image/png`, `image/webp` and `image/gif`. `filename` is optional and only some providers send it on. Parts arrive at the provider in the order you return them, one wire entry each, and each adapter maps them to its own shape (spec §5c). A prompt that returns a plain string is unchanged: it becomes a single text part and the adapters send the same body they always sent.

Parts are checked and frozen **before a quota slot is reserved**, so a bad part costs nothing. A malformed part — an unknown media type, base64 with whitespace or a data-URL prefix, an oversized filename — raises a `TypeError`, and more than **15,000,000 base64 characters of file data in one request** (about 11 MB decoded) raises a `RangeError`. Both are your bugs rather than llmdispatch failures, so they pass through unwrapped with no error code and no attempt record, and neither message ever quotes your file's bytes or its filename (spec §6).

That cap bounds file payload only, and it is llmdispatch's own ceiling rather than a promise that the request fits a given model. Tighter provider limits — per-image byte caps, page counts, total request size — surface as that provider's own error and classify like any other (spec §5b).

**There is no capability model.** llmdispatch does not know which models read PDFs or images, and will not reroute around one that doesn't: a route aimed at a model that cannot take a file part fails with that provider's own error, which typically classifies as `invalid_request` and so does not fall back, though the classification follows whatever the provider actually answers (spec §5b). Point the route at a model that can read the file.

## Output: from model text to typed data

Each operation declares its `format`: `'json'` (the default, a top-level JSON object), `'json-any'` (arrays and scalars), or `'text'`. Built-in adapters enable the provider's native JSON mode when the format is a top-level object and the provider genuinely supports it (verified per provider, spec §5c). Responses are unwrapped from a whole-response code fence if present, parsed, then validated with your Zod schema (async transforms supported). A parse or validation failure is an **output rejection**: fallback-eligible, never silently returned. An optional `quality` gate runs after validation:

```ts
summarize: {
  // ...
  quality: ({ input, data }) =>
    data.summary.length >= 40 ? { ok: true } : { ok: false, reason: 'summary too short' },
  // { ok: false } rejects the output (fallback-eligible).
  // A THROWN exception is a bug in your gate: it fails the run without burning ADDITIONAL fallback spend.
}
```

The exact pipeline is spec §3.

## Errors

Classified llmdispatch failures throw `LLMDispatchError` with a stable `code`. Exceptions from *your own* callbacks pass through raw (see below):

| Code | Meaning | Retryable | Sensible HTTP |
| --- | --- | --- | --- |
| `INVALID_INPUT` | input failed the operation's input schema, or unknown operation name (JS callers) | no | 400 |
| `MISSING_SUBJECT` | operation has an effective quota, declared in code or set on its route, but no `subjectId` was passed | no | 500 (caller bug) |
| `CONFIG_STORE_UNAVAILABLE` | no fresh cached route and the config store is unreachable, so the call is refused, fail-closed. `getQuota` can report it too, since the limit lives in config | yes | 503 |
| `INVALID_CONFIG` | bad or missing route, unregistered provider, unresolvable API key (`detectedAt: 'local'`), or the provider rejected credentials or model (`detectedAt: 'provider'`). `getQuota` can report it too, for the same route problems, even when the limit itself is declared in code | no, except a transient local `prepare()` failure (e.g. secrets service briefly down), which is retryable | 500 |
| `QUOTA_EXCEEDED` | subject hit the daily limit. `error.resetsAt` attached | no (`resetsAt` says when to try again) | 429 |
| `USAGE_STORE_UNAVAILABLE` | quota store unreachable, so the call is refused, fail-closed | yes | 503 |
| `ABORTED` | your `AbortSignal` fired. No fallback attempted | no | 499 |
| `PROVIDER_FAILED` | the final attempt failed at the provider level (see `error.attempts` for the full path) | per final classification (spec §5b) | 502 |
| `OUTPUT_REJECTED` | the final attempt's output failed schema or quality validation, or was truncated by a token limit | yes | 502 |

The table is ordered: pre-dispatch checks run top to bottom, config before quota, so a misconfigured operation never consumes quota. One nuance for an operation whose *code* declares no quota and gets one only from its route: llmdispatch can't know it is quota'd until config resolves, so for that case `CONFIG_STORE_UNAVAILABLE` and `INVALID_CONFIG` surface before `MISSING_SUBJECT`. An operation that declares a quota in code keeps the early check even when a route overrides the number. For post-dispatch failures the code reflects the **final attempt's** classification, with every attempt detailed in `error.attempts` (including token usage of failed runs). A fallback attempt can itself end in `INVALID_CONFIG` or `ABORTED`. The terminal-code mapping is spec §5b.

**`LLMDispatchError`'s package-owned fields are sanitized by design**: classifications, HTTP status codes, safe metadata, never prompts, model output, or raw provider errors from a dispatched attempt. One deliberate pass-through: a pre-dispatch error may chain the underlying store or `prepare()` failure as `cause`, verbatim. That is your own thrown error, or a provider adapter's readiness failure, so do not treat that `cause` as sanitized. Exceptions thrown by *your own* code (prompt builder, quality gate, schema transforms) pass through unwrapped. They're your bugs to see in full.

## When fallback fires

One fallback route per operation, one retry, decided by failure *classification*:

| Primary outcome | Fallback? |
| --- | --- |
| `transient` (network, 5xx), `rate_limit` (429), `malformed_response`, or attempt timeout | ✅ |
| Output rejected (JSON, schema, quality) | ✅ |
| `truncated` (provider signaled a max-token or context cutoff) | ✅ |
| `refused` (provider refusal or safety block, another model will likely refuse too) | ❌ `PROVIDER_FAILED` |
| `auth`, `model_not_found` (config problems, retrying elsewhere hides them) | ❌ `INVALID_CONFIG` by default. Opt in via `fallbackOnAuthOrModelNotFound` |
| `invalid_request` (content-dependent rejection, e.g. context length) | ❌ `PROVIDER_FAILED` |
| Unclassified exception from a custom provider (adapter bug until proven otherwise) | ❌ by default. Opt in via `treatUnclassifiedAsTransient` |
| Your `AbortSignal` fired | ❌ `ABORTED` |
| Anything failing before dispatch (input, config, quota, stores) | ❌ |

`fallbackOnAuthOrModelNotFound: true` on `createSwitch` (off by default) lets a *primary* attempt that dies on bad credentials or an unrecognized model name fall back anyway. That buys availability over noise, for when a stale key shouldn't take an operation down. It's off by default because a broken route is worth finding out about immediately, rather than paying another provider to hide it. It changes nothing else: when the fallback *also* dies on credentials or an unknown model the terminal code is still `INVALID_CONFIG`, and otherwise the final attempt's own classification decides it, as always (spec §5b).

Built-in adapters make exactly one client-side HTTP request per attempt. There are no retries in llmdispatch's own HTTP layer, so `timeoutMs` and `attempts[]` mean what they say (a gateway host may retry upstream internally, which is outside our boundary). Truncated responses and provider refusals are detected from termination metadata (`finish_reason`, `stop_reason`), never passed off as good data: truncation falls back, refusals don't. Timeouts and caller cancellation are classified by llmdispatch itself, not the adapter. A timeout is retry-worthy, a caller who hung up is not.

```ts
operations: { summarize: { /* ... */ timeoutMs: 60_000 } }   // provider I/O timeout per attempt; default 60s
await ai.run('summarize', { input, subjectId }, { signal: controller.signal })
```

## Quotas

Limits are per operation, per `subjectId`, per UTC day, and the *store's* clock owns the day boundary. A limit can be declared in code and overridden at runtime from the config store, exactly like a route ([Runtime config](#runtime-config)). The accounting unit is one **run**: a run and its fallback attempt share one slot. Lifecycle (spec §4 has the exact store contract):

1. **Reserve.** After config checks pass, one slot is atomically reserved. Over the limit gives `QUOTA_EXCEEDED`, with nothing dispatched.
2. **Commit.** An idempotent, confirmed transition immediately before the first provider request. **Committed slots are never refunded**: a run that reaches a provider counts even if it fails, because refunding failures would let a failing user burn unlimited provider spend. llmdispatch never dispatches without a confirmed commit.
3. **Expire.** A reservation that never commits (crash before dispatch) expires after its lease and frees the slot. That is safe, because no provider was called.
4. **Settle.** Attempt records are written idempotently, best-effort with bounded retries and an `onSettlementError` hook. Settlement is accounting only: quota correctness was fixed at commit, and a settlement failure never changes an otherwise successful outcome (the initial write may delay delivery by up to its 10s deadline in the worst case).

**Fail-closed** end to end: unreachable stores refuse calls, and operations with an effective quota refuse without a `subjectId`. Derive `subjectId` server-side from your authenticated session. Never accept it from the client, or users can spend each other's allowance.

```ts
const q = await ai.getQuota('summarize', user.id)
// { limit: 10, used: 3, remaining: 7, resetsAt: '2026-08-11T00:00:00.000Z' }
// used and resetsAt come from the store (authoritative). limit is the effective limit:
// the route's override if it sets one, otherwise the value declared in code, so getQuota
// reads config before usage.
```

Set `perDay: 0` to halt an operation during an incident. Every reservation is denied, no reservation is recorded, and callers get `QUOTA_EXCEEDED` whenever the usage store answers. If that store is itself unreachable the call still refuses, as `USAGE_STORE_UNAVAILABLE`. It takes effect like any other config change (see the cache note under [Runtime config](#runtime-config)), and `getQuota` keeps reporting the day's real `used` while `limit` and `remaining` read 0.

The Postgres adapter stores metadata only (operation, subject, day, states, token counts), **never prompts or outputs**, and ships with pruning guidance (spec §4).

## Runtime config

Routing and daily limits live in the config store, with code-declared defaults underneath. Three functions, enough to build any admin screen on top:

```ts
await ai.getConfig()                    // authoritative: { stored, effective } per operation
await ai.setConfig('summarize', {       // replace-only, validated, last-write-wins (late/racing writes possible cross-process; CAS is deferred), privileged
  provider: 'openai',                   // must be a provider ID registered in code
  model: 'gpt-4.1-mini',
  quota: { perDay: 50 },                // optional: overrides the limit declared in code
  fallback: null,
})
await ai.resetConfig('summarize')       // delete the stored row, so defaultRoute applies again
```

Because the limit rides on the route, changing a daily allowance is an edit on your admin surface, not a deploy: raise it for a customer who needs more, or set it to 0 to stop an operation while you investigate. Leave `quota` off the row and the operation uses the limit declared in its code, since a stored row never inherits a `defaultRoute`'s limit. `resetConfig` puts route and limit back together.

The rules, stated plainly:

- **Config can only reference registered provider IDs**, and secrets never enter the store. With built-in adapters, a tampered row can misroute among *your* registered endpoints but cannot redirect traffic to an arbitrary attacker URL. Scope that honestly: for gateway-style providers (e.g. OpenRouter) the model string itself selects downstream infrastructure, so protect store write access like the privileged surface it is.
- Rows are **validated on every read**. A malformed row fails its own operation (`INVALID_CONFIG`) without poisoning others.
- `defaultRoute` applies **only when a successful store read finds no row**, never as an outage fallback. Expired cache plus unreachable store gives `CONFIG_STORE_UNAVAILABLE`, fail-closed, so an outage can't silently undo an operator's route switch. Full resolution matrix: spec §2.
- Reads are cached per process (default 5s, `configTtlMs`), and a change to a route or a limit reaches another instance when that instance's cached entry expires and it re-reads. This is not an upper bound: an instance that read just before your write can keep serving the old value for one more TTL after that read finishes, and how fast your write becomes visible to other instances' reads is your store's business, not llmdispatch's. Your own process sees its own writes immediately. In-flight runs always finish on the route and limit they resolved with.

## Stores

Two interfaces. Implement them for any database, or use the built-in pairs:

```ts
import { memoryStores, postgresStores } from 'llmdispatch'

stores: memoryStores()                                 // dev & tests, resets on restart
stores: postgresStores({ pool, schema: 'llmdispatch' })  // production, plain SQL, bring your own pg.Pool
```

`postgresStores` ships a versioned SQL migration (you run it, llmdispatch never touches your schema on its own) and uses single-statement atomic operations, safe under concurrency. The exact `ConfigStore` and `UsageStore` contracts, including the idempotent commit protocol and lease semantics, are spec §4 and §6. A **conformance test suite** ships with the package: passing it verifies your custom adapter against every executed case, concurrency included. Check its `skipped` list, because scenarios you don't supply are unverified, not passed.

The pool you hand it must run at `READ COMMITTED`, which is PostgreSQL's default. That is the level the single-statement reserve is built for, and under `REPEATABLE READ` or `SERIALIZABLE` two concurrent reserves abort with a serialization failure (surfaced as the usage store being unavailable) instead of one of them being cleanly denied.

Applying the schema is your job, not the library's. `migrationSql()` from `llmdispatch/postgres` returns the SQL and its sha256, and you run it with whatever tool you already use, in a schema dedicated to llmdispatch. Re-running the same file is safe, because every statement is idempotent, so "apply twice" and "re-run after a failure" are the same operation. A *different* version-1 template is refused by the version record at the end of the file. The file carries no transaction control of its own, though, because migration tools differ on whether they supply theirs: a tool that commits statement by statement leaves the earlier DDL in place when that final record is the thing that conflicts, and re-running the same file is what completes a partial apply.

Apply the whole rendered file in one transaction on one connection, which is also what makes an advisory lock cover the DDL rather than just the call that took it:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(4711);  -- any constant your team reserves for this
-- the SQL from migrationSql()
COMMIT;
```

```ts
import { migrationSql } from 'llmdispatch/postgres'

const { sql } = migrationSql({ schema: 'llmdispatch' })   // your migration tool runs this
```

Whatever store you write it against, the strings llmdispatch hands a store (operation names, provider IDs, models, subject IDs, reservation IDs) are well-formed Unicode, free of U+0000, and at most 1 000 bytes of UTF-8, checked before every store call, so any relational backend can hold them verbatim (spec §6).

## Providers

| Factory | Covers | Release-gated against |
| --- | --- | --- |
| `anthropic()` | Claude models | Anthropic API (live check each release) |
| `openaiCompatible()` | OpenAI-shaped APIs (`baseUrl` for non-OpenAI hosts) | OpenAI, DeepSeek, OpenRouter; others best-effort |
| `gemini()` | Google Gemini models | Gemini API (live check each release) |

Built-in adapters are **zero-dependency**: plain `fetch` against pinned API versions (with redirects disabled, exactly one HTTP request per attempt), no vendor SDKs to install, ever. They're ordinary implementations of the same public `Provider` interface, including its optional `prepare()` readiness hook. Nothing built-in has special powers, so the package stays provider-agnostic by construction.

Why two native adapters instead of routing everything through OpenAI-compatibility layers? Because we verified the compat layers break exactly what llmdispatch depends on. Anthropic's compat endpoint ignores `response_format` entirely (no JSON mode) and is documented by Anthropic as a testing tool, and Gemini's is beta with token totals that silently include unitemized "thinking" tokens, which would corrupt cost tracking. The exact wire contracts and error mappings for all three adapters are spec §5c, with sources, and are also published as a per-adapter reference in [providers.md](./providers.md).

Register every provider you might ever want, on day one. It costs nothing: API keys resolve lazily, so a registered provider with no key only fails if you actually route to it. A `fallback` on a route counts as routed, so its key is checked before anything runs. Adding a provider later is then one env var and one route change in your admin screen, with no code push. `openaiCompatible` pointed at a gateway such as OpenRouter reaches a large model catalogue through a single registration.

Custom providers implement one required method (plus an optional `prepare()` readiness hook) and classify their failures with `ProviderError`. The classification is what drives the fallback matrix. Full contract and types: spec §5 and §6.

```ts
import { ProviderError, type Provider } from 'llmdispatch'

const myProvider: Provider = {
  async complete(req) {
    const res = await callMyBackend(req)                 // req.responseFormat tells you text vs JSON
    if (res.status === 429) throw new ProviderError('rate_limit', { status: 429 })
    if (res.status === 401) throw new ProviderError('auth', { status: 401 })
    if (res.cutOff) return { kind: 'truncated', text: res.body, usage: res.tokens ?? null }
    return { kind: 'complete', text: res.body, usage: res.tokens ?? null } // usage null if unreported
  },
}
```

## Cost

Token usage is reported per attempt, normalized from provider-reported counts into `{ inputTokens, outputTokens }`, and `null` when the provider didn't report (spec §7 defines each adapter's mapping). Dollar cost is computed **only from prices you supply**, keyed by provider ID plus model. The same model can cost differently through different providers, and a bundled price table would go stale and lie:

```ts
createSwitch({
  pricing: {
    claude: { 'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 } },
    openai: { 'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 } },
  },
})
```

`result.cost` is a **simple input/output-token estimate** (cached-token discounts and request fees are out of scope, spec §7), and it's `null` whenever any dispatched attempt is unpriced or has unknown usage. Explicitly unknown, never a misleading zero.

## TypeScript

Inference-first: operation names are typed (`ai.run('summarize', …)` compiles, `ai.run('sumarize', …)` doesn't), `input` checks against the operation's input schema, and `result.data` is the output schema's inferred type. All public types (`Provider`, `ProviderError`, `ConfigStore`, `UsageStore`, `LLMDispatchError`, `OperationDefinition`) are exported and specified in spec §6.

## Compatibility

- **Node.js ≥ 20**, server-side only. Browsers and edge runtimes are not supported.
- **No bundled runtime dependencies.** **Zod 4** is the one required peer you install alongside it.
- **ESM and CJS** both supported, with explicit `exports` and bundled type declarations.
- Postgres adapter: PostgreSQL ≥ 14, bring your own pool (any object with a `query` method, so `pg` works but isn't required by llmdispatch).

## Using it in your framework

One instance, called from wherever your server handles requests. Runnable examples: [examples/next](../examples/next) (TypeScript, App Router) and [examples/express](../examples/express) (plain JavaScript).

```ts
// Next.js route handler
export async function POST(req: Request) {
  const userId = await requireUser(req)            // your auth: subjectId must be server-derived
  const parsed = BodySchema.safeParse(await req.json())
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })
  try {
    const result = await ai.run('summarize', { input: parsed.data, subjectId: userId })
    return Response.json(result.data)
  } catch (err) {
    return toHttpResponse(err)                     // map LLMDispatchError codes as in the Errors table
  }
}
```
