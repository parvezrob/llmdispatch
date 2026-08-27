# Express example

A minimal Express server with one llmdispatch operation behind it.

- `switch.js` — the switch: one provider, one `summarize` operation, in-memory stores.
- `server.js` — `POST /summarize`, with `LLMDispatchError` codes mapped to HTTP statuses,
  and `GET /healthz`.

Plain ESM JavaScript. The route is `openaiCompatible`, so it works against OpenAI or any
OpenAI-compatible endpoint — a gateway, or a local model server — by setting
`OPENAI_BASE_URL`.

## In your own project

Nothing here is special to this repository except how the dependency is installed (the
section below). In your own project it is simply:

```bash
npm install llmdispatch zod
```

Then copy `switch.js` and `server.js` and replace the `demo-user` subject with the user id
your auth already gives you.

## Run it from this repository

The dependency here is the tarball this repository packs, so the example always runs
against the bytes that would be published. Two steps:

```bash
# from the repository root
tgz=$(npm pack --silent --pack-destination examples/express)
mv "examples/express/$tgz" examples/express/llmdispatch-local.tgz
```

Then, in this directory:

```bash
npm ci
OPENAI_API_KEY=your-key npm start
```

The committed `package-lock.json` pins the transitive tree but records no checksum
for `llmdispatch-local.tgz`: you pack that file yourself, so its bytes are yours.

```bash
curl -s localhost:3000/summarize \
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

`PORT` and `HOST` are read if set; `OPENAI_BASE_URL` points the provider somewhere other
than OpenAI.

`memoryStores()` is for the demo: config and quota counters live in this process, so
they are not shared between instances and reset on restart. In production use the
Postgres stores instead.
