# llmdispatch

llmdispatch is a model-agnostic Node.js library for named AI operations.

Most apps hard-code one vendor's SDK and scatter model names through the code, so changing the model means a deploy. llmdispatch puts that choice in your database instead.

Define each operation with Zod input and output schemas plus a prompt. llmdispatch routes the call to a provider and model, then validates the response before it reaches you.

- Change routes and daily per-user limits from your own Postgres, with no deploy.
- Retry once on a fallback model when the failure is worth retrying.
- Keep API keys in environment variables or a secrets manager. You pass a resolver function; the library never stores a key.
- Call Anthropic, Gemini, or any OpenAI-compatible API through built-in `fetch` adapters. No vendor SDKs.
- Generate images (through OpenAI's Images API, OpenRouter's Image API or Gemini) and SVG documents (through OpenRouter) with the same operations.

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

## Generating images

An operation with `format: 'image'` returns generated images instead of text. Give it the packaged `imageOutputSchema` as its output and route it to a model that makes images:

```ts
import {
  createSwitch,
  defineOperation,
  defineOperations,
  imageOutputSchema,
  memoryStores,
  openaiImages,
} from 'llmdispatch'
import { z } from 'zod'

const ai = createSwitch({
  providers: { images: openaiImages({ apiKey: () => process.env.OPENAI_API_KEY }) },
  operations: defineOperations({
    artwork: defineOperation({
      input: z.object({ subject: z.string().max(500) }),
      output: imageOutputSchema,
      prompt: ({ subject }) => `A flat illustration of ${subject}, isolated, with nothing behind it`,
      format: 'image',
      image: { count: 2, aspectRatio: '1:1', size: '2K', background: 'transparent' },
      quota: { perDay: 5 },
      timeoutMs: 120_000,
      defaultRoute: { provider: 'images', model: 'gpt-image-2' },
    }),
  }),
  stores: memoryStores(),
})

const { data } = await ai.run('artwork', { input: { subject: 'a howling wolf' }, subjectId: 'user-123' })
for (const image of data.images) console.log(image.mediaType, image.width, image.height)
```

The `image` block is optional, and so is each knob in it. A knob you leave out never reaches the provider, which then uses its own default:

- `count`: how many images one run asks for, 1 to 10.
- `aspectRatio`: `'1:1'`, `'16:9'`, `'9:16'`, `'4:3'`, `'3:4'`, `'3:2'` or `'2:3'`.
- `size`: a resolution class, `'1K'`, `'2K'` or `'4K'`. It is the provider's class, not a pixel count.
- `background`: `'transparent'` or `'opaque'`.

A model that does not take a value answers with its own error, which usually classifies `invalid_request` and does not fall back.

`result.data` is `{ images, text }`. Each image is a `GeneratedImage`: `{ type: 'file', mediaType, data, width, height }`, where `mediaType` is `image/png`, `image/jpeg` or `image/webp` and `data` is base64. `width` and `height` are the encoded image's own pixels, read from its header (or stated by the provider and checked against the header), so a minimum resolution can be enforced on them before anything decodes the image; EXIF orientation is not applied. A generated image is a file part, so it can go straight into a later prompt. A response with no images is an output rejection, and an image the library cannot read is `malformed_response`; both fall back. `imageOutputSchema.refine(...)` adds a rule of your own, such as an exact count or a minimum width.

### Choosing a provider

| Factory | Use it for | What to know |
| --- | --- | --- |
| `openaiImages()` | Artwork that needs a transparent background | OpenAI's Images API, whose GPT Image models take a transparent background natively. The adapter never asks for another format, so images come back as PNG. `aspectRatio` and `size` must be set together, and `4K` exists only at `16:9`; anything else fails before a request is made. |
| `gemini()` | Opaque art such as posters and previews | The same factory as for text. Native 4K, and usage split by modality, so image tokens can be priced. `background: 'transparent'` fails before a request is made, since no Gemini image model produces an alpha channel. |
| `openrouterImages()` | Many image models with one key | OpenRouter's Image API. When a response carries OpenRouter's charge in `usage.cost`, that is the call's cost; when it does not, your price table applies, or the cost is `null` (see the guide's Cost section). Every knob is sent as it is, and which ones a model honours is listed per model in the catalogue at https://openrouter.ai/api/v1/images/models. |

Whether Gemini's image models honour `count` (sent as `candidateCount`) is not yet verified. A model may return fewer images than asked for, or reject the request with `invalid_request`. Until that is settled, ask Gemini for one image per run, and use `openaiImages` or `openrouterImages` when one run must return several.

### Quota, timeouts and moderation

An image costs tens of times what a text call does, and `count` multiplies it. **Give every image operation its own quota.** One run uses one quota slot whatever `count` says, so the quota limits runs, not images. **Set `timeoutMs` to around `120_000`** for image operations: a 2K image, a larger model or several images can take longer than the 60-second default.

There are two places to screen content, and both are yours:

```ts
const blocked = /\b(?:logo|trademark)\b/i // your own list

input: z.object({
  subject: z.string().max(500).refine((subject) => !blocked.test(subject), 'not allowed'),
}),
quality: async ({ data }) =>
  (await screenImages(data.images)) ? { ok: true } : { ok: false, reason: 'screened out' },
```

The input schema runs before any quota is reserved or any money is spent, so a prompt it rejects costs nothing and fails as `INVALID_INPUT`. The quality gate runs after the images have been generated and paid for. Its `{ ok: false }` is an output rejection, which falls back like any other.

When a provider's own policy blocks a request, the attempt ends `refused`. That is terminal: there is no fallback, the slot stays used, and the run fails with `PROVIDER_FAILED`, with the outcome in `error.attempts`. OpenRouter answers some blocks with a 403 instead, which classifies `invalid_request` and is just as terminal. `openaiImages` never lowers OpenAI's moderation setting.

What the library does not check: whether a transparent PNG actually has transparent pixels (a prompt that describes a backdrop can override the setting), the colour space and the megapixel count. Nor does it enforce your application's own size limit: the only bound it applies is a safety cap of 30 000 000 base64 characters per image. Validate a generated image as you would an upload.

### SVG documents

An operation with `format: 'svg'` returns SVG documents from a vector model: one whose catalogue entry lists `svg` output, such as `recraft/recraft-v4-vector`. Its knobs go in an `svg` block, which takes `count` (1 to 10) and `aspectRatio` and nothing else: a vector has no resolution class and no background setting.

```ts
logo: defineOperation({
  input: z.object({ subject: z.string().max(500) }),
  output: svgOutputSchema,
  prompt: ({ subject }) => `A flat vector icon of ${subject}`,
  format: 'svg',
  svg: { count: 2, aspectRatio: '1:1' },
  quota: { perDay: 5 },
  timeoutMs: 120_000,
  defaultRoute: { provider: 'router', model: 'recraft/recraft-v4-vector' },
}),
```

Here `router` is `openrouterImages({ apiKey: () => process.env.OPENROUTER_API_KEY })`. `result.data` is `{ svgs, text }`, and each document is a `GeneratedSvg`: `{ type: 'svg', mediaType: 'image/svg+xml', data }`, where `data` is base64 of the document's bytes exactly as the provider sent them. It has no width or height.

SVG output has not yet been checked against a live answer from a Recraft vector model, so whether their documents pass the check described below is still open.

`openrouterImages` is the only built-in that produces SVG, and only with a vector model that takes a text prompt alone: two of the Recraft vector models also require a reference image, which this adapter does not send, so they answer with an error (spec §5c). Every other built-in rejects an `'svg'` operation with `invalid_request` before making a request. A raster-only model either rejects it with its own error (usually `invalid_request`, which does not fall back) or answers with a raster image (`malformed_response`, which falls back). Route an SVG operation, and its fallback, to SVG-capable models only.

The library guarantees that each document is strict UTF-8 with no NUL character, rooted in an element named exactly `svg`, with no DTD: before the root there may be only a byte order mark, an XML declaration (naming UTF-8 if it names an encoding), whitespace and comments. The root's namespace is not checked. A document carrying a DOCTYPE is refused by design, as `malformed_response`, which falls back.

**That is all it guarantees.** A document is not checked to be well-formed XML, and it is not safe content: SVG can carry scripts, event handlers and external references, and they pass through untouched. Sanitize every document with a maintained sanitizer, or rasterize it with a renderer that has no network access and bounded resources. Never insert one into a page or serve it as it came.

## Production

`memoryStores()` holds routes and quota counters in one process. It is for development and it resets on restart.

In production use `postgresStores({ pool, schema: 'llmdispatch' })` with your own pool. Apply the SQL from `migrationSql()` in `llmdispatch/postgres` with your usual migration tool; the library never touches your schema itself.

Admin code on your server calls `ai.setConfig()` to change a route or a daily limit without a deploy. Postgres holds config and usage metadata only, never prompts, model output, or keys.

## Limits

Server-side only, Node.js 20 or newer, ESM and CJS. Input is text, PDFs and images; output is text, validated JSON, generated images, or SVG documents through an adapter that supports them. Files go up as base64 in the request; URLs, file references and audio or video are not supported. No streaming yet.

## Documentation

The [guide](./docs/guide.md) covers Postgres setup, runtime config, the fallback rules, quotas, errors, cost and image pricing, custom stores and providers, and framework examples. The exact contract is in the [specification](./docs/spec.md).

## Contributing

Issues and pull requests are welcome. For API changes, open an issue before building, since [docs/spec.md](./docs/spec.md) is the contract under discussion. Report security problems privately through [SECURITY.md](./SECURITY.md), not in a public issue. Releases are published from CI with provenance.

## License

[MIT](./LICENSE)
