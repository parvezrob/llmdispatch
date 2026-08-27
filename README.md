# llmdispatch

llmdispatch is a model-agnostic Node.js library for named AI operations.

Most apps hard-code one vendor's SDK and scatter model names through the code, so changing the model means a deploy. llmdispatch puts that choice in your database instead.

Define each operation with Zod input and output schemas plus a prompt. llmdispatch routes the call to a provider and model, then validates the response before it reaches you.

- Change routes and daily per-user limits from your own Postgres, with no deploy.
- Retry once on a fallback model when the failure is worth retrying.
- Keep API keys in environment variables or a secrets manager. You pass a resolver function; the library never stores a key.
- Call Anthropic, Gemini, or any OpenAI-compatible API through built-in `fetch` adapters. No vendor SDKs.

There is no hosted proxy. Your server calls the providers directly.

## Quickstart

Install llmdispatch and its Zod 4 peer dependency:

```bash
npm install llmdispatch zod
```

The example uses top-level `await`, so run it in an ESM project. Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` first.

```ts
import {
  anthropic,
  createSwitch,
  defineOperation,
  defineOperations,
  memoryStores,
  openaiCompatible,
} from 'llmdispatch'
import { z } from 'zod'

const ai = createSwitch({
  providers: {
    claude: anthropic({ apiKey: () => process.env.ANTHROPIC_API_KEY }),
    openai: openaiCompatible({ apiKey: () => process.env.OPENAI_API_KEY }),
  },

  operations: defineOperations({
    summarize: defineOperation({
      input: z.object({ text: z.string().max(50_000) }),
      output: z.object({
        summary: z.string(),
        keyPoints: z.array(z.string()),
      }),
      prompt: ({ text }) =>
        `Summarize this as JSON with "summary" and "keyPoints".\n\n${text}`,
      quota: { perDay: 10 },
      defaultRoute: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        fallback: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
    }),
  }),

  stores: memoryStores(),
})

const result = await ai.run('summarize', {
  input: { text: 'Solar panel efficiency keeps rising and battery prices keep falling.' },
  subjectId: 'user-123',
})

console.log(result.data)
```

`result.data` is inferred as `{ summary: string; keyPoints: string[] }` and has already passed your output schema. The result also reports which route answered, whether the fallback was used, and what the call cost.

The fallback needs its own API key. Delete the `fallback` line and the second provider if you only have one.

## Documents and images

A prompt can return an array of content parts instead of a string, so an operation can send a PDF or an image alongside its text:

```ts
prompt: ({ note, invoice }) => [                      // invoice: buffer.toString('base64')
  { type: 'text', text: `Answer using the attached invoice.\n\n${note}` },
  { type: 'file', mediaType: 'application/pdf', data: invoice, filename: 'invoice.pdf' },
]
```

`data` is a base64 string, not a `Buffer`. The media types are `application/pdf`, `image/jpeg` (not `image/jpg`, which is rejected), `image/png`, `image/webp` and `image/gif`, and one request may carry up to 15,000,000 base64 characters of file data, roughly 11 MB decoded. Over that the call fails before it reaches a provider or spends quota. Unknown fields on a part are dropped rather than rejected, so spell it `filename`.

Returning a string still works exactly as before. There is no capability model: route an operation that sends a file to a model that cannot read one and the call fails with that provider's own error, rather than being quietly sent somewhere else.

## Production

`memoryStores()` holds routes and quota counters in one process. It is for development and it resets on restart.

In production use `postgresStores({ pool, schema: 'llmdispatch' })` with your own pool. Apply the SQL from `migrationSql()` in `llmdispatch/postgres` with your usual migration tool; the library never touches your schema itself.

Admin code on your server calls `ai.setConfig()` to change a route or a daily limit without a deploy. Postgres holds config and usage metadata only, never prompts, model output, or keys.

## Limits

Server-side only, Node.js 20 or newer, ESM and CJS. Input is text, PDFs and images, output is text or validated JSON. Files go up as base64 in the request; URLs, file references and audio or video are not supported. No streaming yet.

## Documentation

The [guide](./docs/guide.md) covers Postgres setup, runtime config, the fallback rules, quotas, errors, cost, custom stores, and framework examples. The exact contract is in the [specification](./docs/spec.md).

## Contributing

Issues and pull requests are welcome. For API changes, open an issue before building, since [docs/spec.md](./docs/spec.md) is the contract under discussion. Report security problems privately through [SECURITY.md](./SECURITY.md), not in a public issue. Releases are published from CI with provenance.

## License

[MIT](./LICENSE)
