---
'llmdispatch': minor
---

Requests can now carry documents and images alongside text. An operation's `prompt` may
return an array of content parts — `{ type: 'text', text }` and `{ type: 'file', mediaType,
data, filename? }`, with `data` as base64 and `mediaType` one of `application/pdf`,
`image/jpeg`, `image/png`, `image/webp` or `image/gif` — instead of a string. Returning a
string still works and is unchanged: it normalizes to a single text part, so every existing
operation runs as it did. Parts are validated and frozen before a quota slot is reserved: a
malformed part raises a `TypeError`, and file payload over 15,000,000 base64 characters
raises a `RangeError`, neither of which ever names your file's bytes or filename.

**Breaking for custom `Provider` implementations.** `ProviderRequest.prompt: string` is
replaced by `ProviderRequest.parts: readonly ContentPart[]`. An adapter that read
`req.prompt` reads the text of the single text part instead. The built-in Anthropic,
OpenAI-compatible and Gemini adapters send exactly the body they sent before for a
text-only request.
