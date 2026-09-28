---
'llmdispatch': minor
---

New `openrouterImages({ apiKey, baseUrl? })` factory for OpenRouter's Image API (`POST {baseUrl}/images`), one wire to every image model OpenRouter lists. `count`, `aspectRatio`, `size` and `background` each travel verbatim in their own field, a text or JSON request or one carrying a file part throws `ProviderError('invalid_request')` before any fetch, and each image comes back as a `ProviderImage` from `b64_json` and its `media_type` (anything but PNG, JPEG or WebP, an SVG included, is `malformed_response`). The charge OpenRouter reports in `usage.cost` becomes the attempt's cost. OpenRouter's error envelope follows the rules `openaiCompatible` uses for an OpenRouter host, with one exception: a 2xx answer carrying images is read as the images, whatever error it also embeds, since OpenRouter bills image generation all or nothing.
