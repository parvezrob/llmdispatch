---
'llmdispatch': minor
---

New `openaiImages({ apiKey, baseUrl?, quality? })` factory for the OpenAI Images API generations endpoint (`POST {baseUrl}/images/generations`). It makes images only: a text or JSON request, a request carrying a file part, one of `aspectRatio` and `size` without the other, and `size: '4K'` at any ratio but `16:9` each throw `ProviderError('invalid_request')` before any fetch, and an aspect ratio and size class together map to a fixed pixel size. The optional `quality` option (`'low'`, `'medium'`, `'high'`, `'xhigh'` or `'max'`) is sent verbatim when set; the images come back as `ProviderImage`s from `b64_json`, a moderation block is `refused`, and `usage.imageOutputTokens` is read from `output_tokens_details.image_tokens` when the response reports it.
