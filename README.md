# llmswitch

**Control which LLM handles each operation in your app. Swap providers at runtime, fall back on failure, enforce per-user quotas.**

Works with any Node.js server framework — Next.js, Express, Fastify, or none at all. No proxy to deploy, no SaaS to sign up for. It's a library: `npm install`, wire it to your database, done.

> 🚧 **Pre-release.** v0.1 is under active development — the package is not on npm yet. This README introduces the design; the exact, testable contracts live in **[docs/spec.md](./docs/spec.md)**. Watch the repo for the release.

## Why

Apps that use AI usually have several distinct AI *operations* — parse a document, generate content, rewrite text. Each has different needs: one wants the smartest model, another wants the cheapest. And the right answer changes — prices drop, new models ship, a provider has an outage.

Today most codebases hard-code one provider SDK and scatter model names across the code. Changing anything means a deploy. Adding limits means building rate limiting from scratch.

llmswitch gives you one place to declare your operations, and a control panel's worth of behavior behind a single function call:

- **Per-operation routing** — each operation gets its own provider + model: store overrides with an optional code-declared default, editable at runtime without a redeploy.
- **Schema-validated output** — every operation declares the shape it expects (a [Zod](https://zod.dev) schema); responses are validated before you see them.
- **Automatic fallback** — if the primary route fails in a retry-worthy way, the call retries once on a fallback route, per an explicit classification matrix (spec §5). Credential and unknown-model errors are excluded by default so a misconfiguration stays loud; opt in with `fallbackOnAuthOrModelNotFound` if you'd rather keep serving.
- **Per-user quotas** — daily limits per operation per subject, counted atomically in your database, fail-closed, and editable at runtime like a route.
- **Usage accounting** — provider-reported token counts per attempt; cost estimates if you supply your prices.

What llmswitch deliberately is **not**: it doesn't auto-pick models for you (it's a switchboard, not a brain), it doesn't proxy traffic through anyone's servers, and v0.1 is text-only — no streaming, no PDF/image input yet (both on the [roadmap](#roadmap)).

## Quickstart

Two packages. That's the whole install — built-in adapters are plain-`fetch`, **zero vendor SDKs**:

```bash
npm install llmswitch zod
```

```ts
import { createSwitch, defineOperation, defineOperations, anthropic, openaiCompatible, memoryStores } from 'llmswitch'
import { z } from 'zod'

const ai = createSwitch({
  // 1. Register providers in code. Credentials and endpoints live HERE,
  //    never in runtime config or the database.
  providers: {
    claude: anthropic({ apiKey: () => process.env.ANTHROPIC_API_KEY }),
    openai: openaiCompatible({ apiKey: () => process.env.OPENAI_API_KEY }),
  },

  // 2. Declare operations: typed input, expected output, and how to build the prompt.
  //    Wrap each operation in defineOperation — that's what ties your schemas to your
  //    callbacks, so a typo inside `prompt` is a compile error, not a runtime surprise.
  operations: defineOperations({
    summarize: defineOperation({
      input: z.object({ text: z.string().max(50_000) }),
      output: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }),
      prompt: ({ text }) => `Summarize the following article as JSON with "summary" and "keyPoints".\n\n${text}`,
      quota: { perDay: 10 },
      // Used when the config store has no row for this operation (bootstrap-friendly).
      defaultRoute: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        fallback: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
    }),
  }),

  // 3. Wire storage: runtime config (routes and limits) + quota counters.
  //    Memory for dev, Postgres for prod.
  stores: memoryStores(),
})

const result = await ai.run('summarize', {
  input: { text: articleText },
  subjectId: user.id, // required whenever the operation has an effective quota
})

result.data          // { summary, keyPoints } — typed, validated against your output schema
result.route         // { provider: 'claude', model: 'claude-sonnet-4-6' } — who actually answered
result.usedFallback  // true if the fallback route saved this call
result.attempts      // per-attempt detail: route, outcome, usage (null when the provider didn't report)
result.usage         // token totals across attempts with known usage
result.usageComplete // false if any attempt's usage was unreported (or totals overflowed)
result.cost          // estimated USD, or null unless every dispatched attempt is priced with known usage
```

Three parts: **providers** (who you can call), **operations** (what your app does), **stores** (where config and counters live). `run` does the rest, in a fixed, documented order — validate input, resolve config, check readiness, reserve and commit quota, call, parse, validate output, fall back if warranted, settle. The exact state machine is spec §1 in [docs/spec.md](./docs/spec.md).

> **Planning to switch providers later?** Register every provider you might ever want on day one — it costs nothing. API keys resolve lazily, so a registered provider without a key only errors if you actually route to it. Enabling Anthropic next year is then: set `ANTHROPIC_API_KEY` (a restart/redeploy for the new env var, as with any env change), flip the route in your admin config. **No code push.** (And `openaiCompatible` pointed at OpenRouter reaches virtually every model on the market through one registration.)

## Output: from model text to typed data

Each operation declares its `format`: `'json'` (default — a top-level JSON object), `'json-any'` (arrays/scalars), or `'text'`. Built-in adapters enable the provider's native JSON mode when the format is a top-level object and the provider genuinely supports it (that's per-provider verified — spec §5c). Responses are unwrapped from a whole-response code fence if present, parsed, then validated with your Zod schema (async transforms supported). A parse or validation failure is an **output rejection** — fallback-eligible, never silently returned. An optional `quality` gate runs after validation:

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

Classified llmswitch failures throw `LLMSwitchError` with a stable `code` (exceptions from *your own* callbacks pass through raw — see below):

| Code | Meaning | Retryable | Sensible HTTP |
| --- | --- | --- | --- |
| `INVALID_INPUT` | input failed the operation's input schema, or unknown operation name (JS callers) | no | 400 |
| `MISSING_SUBJECT` | operation has an effective quota — declared in code or set on its route — but no `subjectId` was passed | no | 500 (caller bug) |
| `CONFIG_STORE_UNAVAILABLE` | no fresh cached route and the config store is unreachable — refused, fail-closed; `getQuota` can report it too, since the limit lives in config | yes | 503 |
| `INVALID_CONFIG` | bad or missing route, unregistered provider, unresolvable API key (`detectedAt: 'local'`) — or the provider rejected credentials/model (`detectedAt: 'provider'`); `getQuota` can report it too, for the same route problems, even when the limit itself is declared in code | no — except a transient local `prepare()` failure (e.g. secrets service briefly down): yes | 500 |
| `QUOTA_EXCEEDED` | subject hit the daily limit; `error.resetsAt` attached | no (`resetsAt` says when to try again) | 429 |
| `USAGE_STORE_UNAVAILABLE` | quota store unreachable — refused, fail-closed | yes | 503 |
| `ABORTED` | your `AbortSignal` fired — no fallback attempted | no | 499 |
| `PROVIDER_FAILED` | the final attempt failed at the provider level (see `error.attempts` for the full path) | per final classification (spec §5b) | 502 |
| `OUTPUT_REJECTED` | the final attempt's output failed schema/quality validation, or was truncated by a token limit | yes | 502 |

The table is ordered: pre-dispatch checks run top-to-bottom (config before quota — a misconfigured operation never consumes quota). One nuance for an operation whose *code* declares no quota and gets one only from its route: llmswitch can't know it is quota'd until config resolves, so for that case `CONFIG_STORE_UNAVAILABLE`/`INVALID_CONFIG` surfaces before `MISSING_SUBJECT`. An operation that declares a quota in code keeps the early check even when a route overrides the number. For post-dispatch failures the code reflects the **final attempt's** classification, with every attempt detailed in `error.attempts` (including token usage of failed runs). A fallback attempt can itself end in `INVALID_CONFIG` or `ABORTED` — the terminal-code mapping is spec §5b.

**Error contents are sanitized by design**: classifications, HTTP status codes, safe metadata — never prompts, model output, or raw provider errors. Exceptions thrown by *your own* code (prompt builder, quality gate, schema transforms) pass through unwrapped; they're your bugs to see in full.

## When fallback fires

One fallback route per operation, one retry, decided by failure *classification*:

| Primary outcome | Fallback? |
| --- | --- |
| `transient` (network, 5xx), `rate_limit` (429), `malformed_response`, or attempt timeout | ✅ |
| Output rejected (JSON/schema/quality) | ✅ |
| `truncated` (provider signaled a max-token/context cutoff) | ✅ |
| `refused` (provider refusal/safety block — another model will likely refuse too) | ❌ `PROVIDER_FAILED` |
| `auth`, `model_not_found` (config problems — retrying elsewhere hides them) | ❌ `INVALID_CONFIG` by default — opt in via `fallbackOnAuthOrModelNotFound` |
| `invalid_request` (content-dependent rejection, e.g. context length) | ❌ `PROVIDER_FAILED` |
| Unclassified exception from a custom provider (adapter bug until proven otherwise) | ❌ by default — opt in via `treatUnclassifiedAsTransient` |
| Your `AbortSignal` fired | ❌ `ABORTED` |
| Anything failing before dispatch (input, config, quota, stores) | ❌ |

`fallbackOnAuthOrModelNotFound: true` on `createSwitch` (off by default) lets a *primary* attempt that dies on bad credentials or an unrecognized model name fall back anyway — availability over noise, when a stale key shouldn't take an operation down. It's off by default because a broken route is worth finding out about immediately, rather than paying another provider to hide it, and it changes nothing else: when the fallback *also* dies on credentials or an unknown model the terminal code is still `INVALID_CONFIG`, and otherwise the final attempt's own classification decides it, as always (spec §5b).

Built-in adapters make exactly one client-side HTTP request per attempt — no retries in llmswitch's own HTTP layer, so `timeoutMs` and `attempts[]` mean what they say (a gateway host may retry upstream internally; that's outside our boundary). Truncated responses and provider refusals are detected from termination metadata (`finish_reason`/`stop_reason`), never passed off as good data — truncation falls back, refusals don't. Timeouts and caller cancellation are classified by llmswitch itself, not the adapter: a timeout is retry-worthy, a caller who hung up is not.

```ts
operations: { summarize: { /* ... */ timeoutMs: 60_000 } }   // provider I/O timeout per attempt; default 60s
await ai.run('summarize', { input, subjectId }, { signal: controller.signal })
```

## Quotas

Limits are per operation, per `subjectId`, per UTC day — and the *store's* clock owns the day boundary. A limit can be declared in code and overridden at runtime from the config store, exactly like a route ([Runtime config](#runtime-config)). The accounting unit is one **run**: a run and its fallback attempt share one slot. Lifecycle (spec §4 has the exact store contract):

1. **Reserve** — after config checks pass, one slot is atomically reserved. Over the limit → `QUOTA_EXCEEDED`, nothing dispatched.
2. **Commit** — an idempotent, confirmed transition immediately before the first provider request. **Committed slots are never refunded** — a run that reaches a provider counts even if it fails, because refunding failures would let a failing user burn unlimited provider spend. llmswitch never dispatches without a confirmed commit.
3. **Expire** — a reservation that never commits (crash before dispatch) expires after its lease and frees the slot — safe, because no provider was called.
4. **Settle** — attempt records are written idempotently, best-effort with bounded retries and an `onSettlementError` hook. Settlement is accounting only: quota correctness was fixed at commit, and a settlement failure never changes an otherwise successful outcome (the initial write may delay delivery by up to its 10s deadline in the worst case).

**Fail-closed** end to end: unreachable stores refuse calls; operations with an effective quota refuse without a `subjectId`. Derive `subjectId` server-side from your authenticated session — never accept it from the client, or users can spend each other's allowance.

```ts
const q = await ai.getQuota('summarize', user.id)
// { limit: 10, used: 3, remaining: 7, resetsAt: '2026-08-11T00:00:00.000Z' }
// used and resetsAt come from the store (authoritative); limit is the effective limit —
// the route's override if it sets one, otherwise the value declared in code, so getQuota
// reads config before usage.
```

Set `perDay: 0` to halt an operation during an incident: every reservation is denied, no reservation is recorded, and callers get `QUOTA_EXCEEDED` whenever the usage store answers — if that store is itself unreachable the call still refuses, as `USAGE_STORE_UNAVAILABLE`. It takes effect like any other config change (see the cache note below), and `getQuota` keeps reporting the day's real `used` while `limit` and `remaining` read 0.

The Postgres adapter stores metadata only — operation, subject, day, states, token counts — **never prompts or outputs**, and ships with pruning guidance (spec §4).

## Runtime config

Routing and daily limits live in the config store, with code-declared defaults underneath. Three functions — build any admin screen on top:

```ts
await ai.getConfig()                    // authoritative: { stored, effective } per operation
await ai.setConfig('summarize', {       // replace-only, validated, last-write-wins (late/racing writes possible cross-process; CAS is v0.2), privileged
  provider: 'openai',                   // must be a provider ID registered in code
  model: 'gpt-4.1-mini',
  quota: { perDay: 50 },                // optional: overrides the limit declared in code
  fallback: null,
})
await ai.resetConfig('summarize')       // delete the stored row → defaultRoute applies again
```

Because the limit rides on the route, changing a daily allowance is an edit on your admin surface, not a deploy: raise it for a customer who needs more, or set it to 0 to stop an operation while you investigate. Leave `quota` off the row and the operation uses the limit declared in its code — a stored row never inherits a `defaultRoute`'s limit — and `resetConfig` puts route and limit back together.

The rules, stated plainly:

- **Config can only reference registered provider IDs**, and secrets never enter the store. With built-in adapters, a tampered row can misroute among *your* registered endpoints but cannot redirect traffic to an arbitrary attacker URL. Scope honestly: for gateway-style providers (e.g. OpenRouter) the model string itself selects downstream infrastructure — protect store write access like the privileged surface it is.
- Rows are **validated on every read**; a malformed row fails its own operation (`INVALID_CONFIG`) without poisoning others.
- `defaultRoute` applies **only when a successful store read finds no row** — never as an outage fallback. Expired cache + unreachable store = `CONFIG_STORE_UNAVAILABLE`, fail-closed, so an outage can't silently undo an operator's route switch. Full resolution matrix: spec §2.
- Reads are cached per process (default 5s, `configTtlMs`), and a change — to a route or a limit — reaches another instance when that instance's cached entry expires and it re-reads. This is not an upper bound: an instance that read just before your write can keep serving the old value for one more TTL after that read finishes, and how fast your write becomes visible to other instances' reads is your store's business, not llmswitch's. Your own process sees its own writes immediately. In-flight runs always finish on the route and limit they resolved with.

## Stores

Two interfaces; implement them for any database, or use the built-in pairs:

```ts
import { memoryStores, postgresStores } from 'llmswitch'

stores: memoryStores()                                 // dev & tests — resets on restart
stores: postgresStores({ pool, schema: 'llmswitch' })  // production — plain SQL, bring your own pg.Pool
```

`postgresStores` ships a versioned SQL migration (you run it — llmswitch never touches your schema on its own) and uses single-statement atomic operations, safe under concurrency. The exact `ConfigStore`/`UsageStore` contracts — including the idempotent commit protocol and lease semantics — are spec §4 and §6, and a **conformance test suite** ships with the package: passing it verifies your custom adapter against every executed case, concurrency included — check its `skipped` list, because scenarios you don't supply are unverified, not passed.

Whatever store you write it against, the strings llmswitch hands a store — operation names, provider IDs, models, subject IDs, reservation IDs — are well-formed Unicode, free of U+0000, and at most 1 000 bytes of UTF-8, checked before every store call, so any relational backend can hold them verbatim (spec §6).

## Providers

| Factory | Covers | Release-gated against |
| --- | --- | --- |
| `anthropic()` | Claude models | Anthropic API (live check each release) |
| `openaiCompatible()` | OpenAI-shaped APIs (`baseUrl` for non-OpenAI hosts) | OpenAI, DeepSeek, OpenRouter; others best-effort |
| `gemini()` | Google Gemini models | Gemini API (live check each release) |

Built-in adapters are **zero-dependency**: plain `fetch` against pinned API versions (with redirects disabled — exactly one HTTP request per attempt), no vendor SDKs to install, ever. They're ordinary implementations of the same public `Provider` interface, including its optional `prepare()` readiness hook — nothing built-in has special powers, so the package stays provider-agnostic by construction.

Why two native adapters instead of routing everything through OpenAI-compatibility layers? Because we verified the compat layers break exactly what llmswitch depends on: Anthropic's compat endpoint ignores `response_format` entirely (no JSON mode) and is documented by Anthropic as a testing tool, and Gemini's is beta with token totals that silently include unitemized "thinking" tokens — which would corrupt cost tracking. The exact wire contracts and error mappings for all three adapters are spec §5c, with sources.

Custom providers implement one required method (plus an optional `prepare()` readiness hook) and classify their failures with `ProviderError` — the classification is what drives the fallback matrix. Full contract and types: spec §5–6.

```ts
import { ProviderError, type Provider } from 'llmswitch'

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

Token usage is reported per attempt, normalized from provider-reported counts into `{ inputTokens, outputTokens }` (`null` when the provider didn't report — spec §7 defines each adapter's mapping). Dollar cost is computed **only from prices you supply**, keyed by provider ID + model — the same model can cost differently through different providers, and a bundled price table would go stale and lie:

```ts
createSwitch({
  pricing: {
    claude: { 'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 } },
    openai: { 'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 } },
  },
})
```

`result.cost` is a **simple input/output-token estimate** (cached-token discounts and request fees are out of scope in v0.1 — spec §7), and it's `null` whenever any dispatched attempt is unpriced or has unknown usage — explicitly unknown, never a misleading zero.

## TypeScript

Inference-first: operation names are typed (`ai.run('summarize', …)` compiles, `ai.run('sumarize', …)` doesn't), `input` checks against the operation's input schema, and `result.data` is the output schema's inferred type. All public types — `Provider`, `ProviderError`, `ConfigStore`, `UsageStore`, `LLMSwitchError`, `OperationDefinition` — are exported and specified in spec §6.

## Compatibility

- **Node.js ≥ 20**, server-side only. Browsers and edge runtimes are not supported in v0.1.
- **No bundled runtime dependencies** — **Zod 4** is the one required peer you install alongside it.
- **ESM and CJS** both supported, with explicit `exports` and bundled type declarations.
- Postgres adapter: PostgreSQL ≥ 14, bring your own pool (any object with a `query` method — `pg` works, but isn't required by llmswitch).

## Using it in your framework

One instance, called from wherever your server handles requests. Full runnable examples (Next.js and Express) will be added before v0.1 ships.

```ts
// Next.js route handler
export async function POST(req: Request) {
  const userId = await requireUser(req)            // your auth — subjectId must be server-derived
  const parsed = BodySchema.safeParse(await req.json())
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })
  try {
    const result = await ai.run('summarize', { input: parsed.data, subjectId: userId })
    return Response.json(result.data)
  } catch (err) {
    return toHttpResponse(err)                     // map LLMSwitchError codes as in the Errors table
  }
}
```

## Roadmap

- **v0.1** — everything above
- **v0.2 candidates** — PDF/image input (provider-neutral content parts), per-subject quota overrides, headless admin UI kit, eval CLI for testing a provider switch before committing, streaming, Redis/SQLite stores

## Contributing

Issues and PRs welcome — the project is actively developed and maintained. For API changes, open an issue to discuss before building; [docs/spec.md](./docs/spec.md) is the contract under discussion. A security policy (private vulnerability reporting) and release provenance will be in place at first release.

## License

[MIT](./LICENSE)
