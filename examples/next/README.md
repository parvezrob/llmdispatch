# Next.js example

A Next.js App Router project with one llmswitch operation behind a route handler.

- `lib/switch.ts` — the switch: one provider, one `summarize` operation, in-memory stores.
- `app/api/summarize/route.ts` — `POST`, with `LLMSwitchError` codes mapped to HTTP
  statuses.
- `app/api/healthz/route.ts` — `GET`.

TypeScript, Node.js runtime. The route is `openaiCompatible`, so it works against OpenAI
or any OpenAI-compatible endpoint — a gateway, or a local model server — by setting
`OPENAI_BASE_URL`.

## Run it

The dependency here is the tarball this repository packs, so the example always runs
against the bytes that would be published. Two steps:

```bash
# from the repository root
tgz=$(npm pack --silent --pack-destination examples/next)
mv "examples/next/$tgz" examples/next/llmswitch-local.tgz
```

Then, in this directory:

```bash
npm ci
npm run build
OPENAI_API_KEY=your-key npm start
```

The committed `package-lock.json` pins the transitive tree but records no checksum
for `llmswitch-local.tgz`: you pack that file yourself, so its bytes are yours.

```bash
curl -s localhost:3000/api/summarize \
  -H 'content-type: application/json' \
  -d '{"text":"Rooftop solar keeps climbing, and falling battery prices finally make home storage practical."}'
```

The answer is the operation's validated output plus the route that produced it:

```json
{
  "data": { "summary": "…", "keyPoints": ["…"] },
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "usedFallback": false
}
```

The switch is a module-level value, so one instance is shared by every request the server
handles. `OPENAI_BASE_URL` points the provider somewhere other than OpenAI.

`memoryStores()` is for the demo: config and quota counters live in this process, so
they are not shared between instances and reset on restart. In production use the
Postgres stores instead.

## In your own project

Nothing here is special to this repository except the tarball. In your own project the
dependency is simply:

```bash
npm install llmswitch zod
```

Then copy `lib/switch.ts` and the route handler, and replace the `demo-user` subject with
the user id your auth already gives you.
