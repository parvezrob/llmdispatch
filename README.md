# llmdispatch

**Control which LLM handles each operation in your app. Swap providers at runtime, fall back on failure, enforce per-user quotas.**

Works with any Node.js server framework — Next.js, Express, Fastify, or none at all. No proxy to deploy, no SaaS to sign up for. It's a library: `npm install`, wire it to your database, done.


## Why

Apps that use AI usually have several distinct AI *operations* — parse a document, generate content, rewrite text. Each wants a different model, and the right answer keeps changing: prices drop, new models ship, a provider has an outage. Most codebases hard-code one vendor SDK and scatter model names through the code, so changing any of it means a deploy, and adding limits means building rate limiting from scratch.

llmdispatch gives you one place to declare your operations and one function call to run them. Each operation gets its own provider and model, editable at runtime from your own database. Output is validated against a [Zod](https://zod.dev) schema before you see it. A retry-worthy failure falls back once, on an explicit classification. Daily per-user limits are counted atomically where your data already lives.

It's a switchboard, not a brain: it won't pick models for you, it doesn't proxy your traffic through anyone's servers, and v0.1 is text-only — no streaming, no PDF or image input yet (both on the [roadmap](#roadmap)).

## Quickstart

Two packages. That's the whole install — built-in adapters are plain-`fetch`, **zero vendor SDKs**:

```bash
npm install llmdispatch zod
```

Any package manager works — `pnpm add llmdispatch zod` or `yarn add llmdispatch zod`.

The snippet uses top-level `await`, so it needs an ESM project. In a fresh directory, run `npm pkg set type=module` first, or save the file as `.mts`.

```ts
import { createSwitch, defineOperation, defineOperations, anthropic, openaiCompatible, memoryStores } from 'llmdispatch'
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
        // The fallback needs its own API key. Only have one provider? Delete this line.
        fallback: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
    }),
  }),

  // 3. Wire storage: runtime config (routes and limits) + quota counters.
  //    Memory for dev, Postgres for prod.
  stores: memoryStores(),
})

// The inputs your app supplies: the text to process, and whose quota to count.
const articleText =
  'Rooftop solar keeps climbing: panel efficiency has improved for a decade, perovskite cells promise cheaper manufacturing, and falling battery prices finally make home storage practical. Analysts expect residential installations to double within five years.'
const user = { id: 'user-123' }

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

> **Planning to switch providers later?** Register every provider you might ever want on day one — it costs nothing. API keys resolve lazily, so a registered provider without a key only errors if you actually route to it. A `fallback` on your route counts as routed: its key is checked before anything runs. If you only have one key today, drop the quickstart's `fallback` line. Enabling Anthropic next year is then: set `ANTHROPIC_API_KEY` (a restart/redeploy for the new env var, as with any env change), flip the route in your admin config. **No code push.** (And `openaiCompatible` pointed at OpenRouter reaches virtually every model on the market through one registration.)

## What else you get

Each of these is covered in full in [the guide](./docs/guide.md).

- **[Typed output](./docs/guide.md#output-from-model-text-to-typed-data)** — responses are unwrapped, parsed and validated against your schema, with an optional quality gate; a failure is a rejection, never bad data handed back.
- **[Errors worth routing on](./docs/guide.md#errors)** — one `LLMDispatchError` with a stable code per failure mode, each with a sensible HTTP status and sanitized fields.
- **[Fallback rules](./docs/guide.md#when-fallback-fires)** — an explicit matrix decides which failures retry on the fallback route; credential and unknown-model errors stay loud by default.
- **[Per-user quotas](./docs/guide.md#quotas)** — daily limits per operation per subject, reserved and committed atomically in your database, fail-closed, never refunded after dispatch.
- **[Runtime config](./docs/guide.md#runtime-config)** — three functions to read and write routes and limits, so an admin screen can change either without a deploy.
- **[Stores](./docs/guide.md#stores)** — memory for dev, Postgres for production, or your own adapter behind two small interfaces, with a conformance suite that proves it.
- **[Providers](./docs/guide.md#providers)** — `anthropic()`, `gemini()` and `openaiCompatible()`, all plain `fetch` against pinned API versions, plus the contract for writing your own.
- **[Cost](./docs/guide.md#cost)** — per-attempt token usage, and dollar estimates from prices you supply; `null` rather than a misleading zero.
- **[TypeScript](./docs/guide.md#typescript)** — operation names, inputs and `result.data` are all inferred, and every public type is exported.
- **[Compatibility](./docs/guide.md#compatibility)** — Node.js ≥ 20, ESM and CJS, Zod 4 as the one peer dependency, PostgreSQL ≥ 14 for the Postgres adapter.
- **[Using it in your framework](./docs/guide.md#using-it-in-your-framework)** — one instance, called from a route handler; runnable Next.js and Express examples ship in the repository.

## Roadmap

- **v0.1** — everything above
- **v0.2 candidates** — PDF/image input (provider-neutral content parts), per-subject quota overrides, headless admin UI kit, eval CLI for testing a provider switch before committing, streaming, Redis/SQLite stores

## Contributing

Issues and PRs welcome — the project is actively developed and maintained. For API changes, open an issue to discuss before building; [docs/spec.md](./docs/spec.md) is the contract under discussion. Security problems go through private vulnerability reporting instead — see [SECURITY.md](./SECURITY.md). Stable releases will carry provenance.

## License

[MIT](./LICENSE)
