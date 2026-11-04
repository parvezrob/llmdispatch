---
'llmdispatch': minor
---

`openrouterImages` now maps OpenRouter's SVG output (`output_format: 'svg'`): an `'svg'` request sends `output_format: 'svg'`, plus `n` and `aspect_ratio` only when set and never `resolution` or `background`, and a vectorization model's answer comes back as `svgs`, each element required to carry `media_type` `image/svg+xml` (a raster answer is `malformed_response`) within the core's three SVG caps, read before any grammar scan. The core then runs its SVG document check on every answer, usage and the reported `usage.cost` are read as for images, and a model that rejects `output_format: 'svg'` with a 4xx classifies by the usual status rows (a 400 is `invalid_request`, with no fallback). An `'image'` request still never sends `output_format` and still treats an SVG answer as `malformed_response`.
