---
'llmdispatch': minor
---

The `gemini` adapter maps image output. An image request sends `responseModalities: ['TEXT','IMAGE']` with `imageConfig.aspectRatio`, `imageConfig.imageSize` and `candidateCount` only when the operation set them, and reads every candidate's inline `image/png`, `image/jpeg` or `image/webp` part back as a `ProviderImage`, with the text beside it and `usage.imageOutputTokens` from the `IMAGE` modality entry of `candidatesTokensDetails`. Finish reasons are weighed across all candidates: `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT` and `IMAGE_RECITATION` join the refused set, `IMAGE_OTHER` is `malformed_response`, and a `NO_IMAGE` candidate contributes nothing. `background: 'transparent'` throws `ProviderError('invalid_request')` before any fetch, since no model in the family produces an alpha channel.

The core now caps what a response may hand back: more than 10 images, or one image's `data` over 30 000 000 base64 characters, classifies `malformed_response` on the count and the length alone, before the base64 grammar and the image header reader run.
