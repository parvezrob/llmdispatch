---
'llmdispatch': minor
---

Image output through `run()`. An operation may declare `format: 'image'` with an optional `image` block (`count`, `aspectRatio`, `size`, `background`, validated at `createSwitch`); the request then carries `responseFormat: { type: 'image', ...knobs }`, and a complete response's `images` become dimensioned, frozen `GeneratedImage` file parts that the output schema and the quality gate receive as `{ images, text }`. The packaged `imageOutputSchema` accepts exactly that shape. Dimensions the adapter leaves out are read from the PNG, WebP or JPEG header; stated ones are checked against it. Zero images is an output rejection; a malformed image classifies `malformed_response`.

Cost model: `TokenUsage.imageOutputTokens` (an "of which" count inside `outputTokens`), `ModelPrice.imageOutputPerM`, and a provider-reported `ProviderResponse.costUsd` that is authoritative when present and well-formed. The `image_output` provider conformance scenario and the usage-store round trip of the new counter are part of the suites.

Breaking for custom `Provider` implementations: `responseFormat.type` may now be `'image'`; reject it with `ProviderError('invalid_request')` unless you support it. The built-in adapters do exactly that in this release. Breaking for custom `UsageStore` implementations under the conformance suite: the settled attempt record now carries `usage.imageOutputTokens`, and a store that persists only the two base counters fails the round-trip case.
