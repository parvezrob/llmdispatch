---
'llmdispatch': minor
---

New `openrouterImages({ apiKey, baseUrl? })` factory for OpenRouter's Image API (`POST {baseUrl}/images`), one wire to every image model OpenRouter lists. `count`, `aspectRatio`, `size` and `background` each travel verbatim in their own field, a text or JSON request or one carrying a file part throws `ProviderError('invalid_request')` before any fetch, and each image comes back as a `ProviderImage` from `b64_json` and its `media_type` (anything but PNG, JPEG or WebP, an SVG included, is `malformed_response`). The charge OpenRouter reports in `usage.cost` becomes the attempt's cost, and OpenRouter's error envelope classifies exactly as it does for `openaiCompatible`.
