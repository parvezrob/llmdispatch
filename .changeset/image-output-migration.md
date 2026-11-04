---
'llmdispatch': minor
---

Upgrading a custom `Provider` from 0.2: `ProviderRequest.responseFormat.type` has two new members, `'image'` and `'svg'`, and the compiler reports them only where a switch over the type is exhaustive. Code that branches two ways, such as `req.responseFormat.type === 'json' ? parseJson(body) : body`, keeps compiling and answers an image or SVG operation with text, which the core then rejects as output with no images or documents, after the provider call has been made and paid for. The fix is one line at the top of `complete()`, unless your backend produces that output: `if (req.responseFormat.type === 'image' || req.responseFormat.type === 'svg') throw new ProviderError('invalid_request')`. The attempt then fails as `invalid_request` before any request is sent, with no fallback, as it does on the built-in adapters that have no image or SVG wire. The guide's custom-provider example does exactly this.
