<!-- Generated from docs/spec.md §5c by scripts/build-provider-reference.mjs — do not
     edit this file. Edit the spec, then run `npm run docs:providers`. -->

# Provider wire reference

> Generated verbatim from [docs/spec.md](./spec.md) §5c, the authoritative wire
> contracts for the built-in adapters. Edit the spec, then run `npm run docs:providers`.

## Contents

- [All adapters](#all-adapters)
- [`openaiCompatible`](#openaicompatible)
- [`anthropic`](#anthropic)
- [`gemini`](#gemini)

## All adapters

All built-ins: `fetch` with `redirect: 'error'`, JSON bodies, per-attempt signal.
**Optional request fields (`maxOutputTokens`, `temperature`) are omitted from the wire body
when unset — never defaulted** (single exception: Anthropic `max_tokens` below). Every
mapping is fixed by recorded synthetic fixtures.
**Universal status-family default (all built-ins, total by construction):** any status not
explicitly mapped classifies by family — 401/403 → `auth` (except documented moderation
envelopes → `refused`); 402/429 → `rate_limit`; 404 → `model_not_found`; 408 → `transient`;
any other 4xx (incl. 409/413/422) → `invalid_request`; any 5xx (incl. 504/529) →
`transient`; network/DNS/TLS failures → `transient`. Implementers never invent a mapping.

## `openaiCompatible`

**`openaiCompatible({ apiKey, baseUrl?, jsonMode?, tokenParam? })` — the universal transport.**
Default `baseUrl` `https://api.openai.com/v1`; `POST {baseUrl}/chat/completions`;
`Authorization: Bearer`. ([OpenAI API reference](https://platform.openai.com/docs/api-reference/chat))
Request: `model`, `messages: [{role:'user', content: prompt}]`, `max_tokens`,
`temperature`, and `response_format: { type: 'json_object' }` only when JSON-object format
AND the JSON capability applies. **JSON capability rule:** direct known-good hosts
(api.openai.com, api.deepseek.com, api.groq.com, api.mistral.ai) get native `json_object`;
**model-multiplexing gateways (openrouter.ai, api.together.xyz, api.fireworks.ai) and
unknown hosts are prompt-only by default** — JSON-mode support there is per-MODEL, not
per-host, and an unsupported route would fail `invalid_request` without fallback; the
factory's `jsonMode: 'native' | 'prompt-only'` overrides either way and is the documented
knob when you know your models. (Ollama
`http://localhost:11434/v1`: key accepted-but-unused; schema formats silently ignored —
prompt-only. [Ollama compat](https://ollama.com/blog/openai-compatibility))
Token parameter: `max_completion_tokens` for host api.openai.com (OpenAI deprecates
`max_tokens` and rejects it on reasoning models), `max_tokens` for all other compat hosts;
factory option `tokenParam: 'max_tokens' | 'max_completion_tokens'` overrides.
Response: `choices[0].message.content`; termination normalized to `ProviderResponse.kind`:
**`message.refusal` non-empty → `'refused'` (checked even when `finish_reason` is
`stop`)**; `finish_reason` `length` → `'truncated'`; `content_filter` → `'refused'`;
`stop` → `'complete'`; other/missing → throw `ProviderError('malformed_response')`.
Usage: `usage.prompt_tokens`/`usage.completion_tokens`; **missing usage envelope or
missing/invalid base counters → `usage: null`** (never zero-defaulted).
**Embedded HTTP-200 errors (OpenRouter):** before completion parsing, a body carrying
`finish_reason: 'error'` or a top-level/choice-level `error` object classifies from its
`error.metadata.error_type`/`code` vocabulary (moderation → `refused`; auth/credit/rate →
`auth`/`rate_limit`; otherwise `transient`) — never treated as normal completion.
Errors ([OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes),
[OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging)):
401 → `auth`; **403: for OpenRouter envelopes carrying moderation metadata →
`invalid_request` (content), otherwise `auth`**; 404/model-not-found codes →
`model_not_found`; 429 and 402 → `rate_limit`; 408/5xx/498 → `transient`; other
400/413/422 → `invalid_request`; unparseable body → classify by status; unknown status →
`transient` (a real HTTP outcome, unlike unclassified thrown values).

## `anthropic`

**`anthropic({ apiKey })` — native Messages API.** `POST
https://api.anthropic.com/v1/messages`; **`x-api-key`** + required
**`anthropic-version: 2023-06-01`**. ([Anthropic Messages](https://docs.anthropic.com/en/api/messages);
the OpenAI-compat layer is not used — it ignores `response_format` and is documented as a
testing tool: [Anthropic OpenAI SDK compat](https://docs.anthropic.com/en/api/openai-sdk))
Request: `model`, `max_tokens` (**always sent** — required by Anthropic; default 4096 when
the route sets none), `messages: [{role:'user', content: prompt}]`, `temperature` (0–1;
core-range values are clamped, documented). JSON is prompt-driven in v0.1.
Response: first `text` block of `content[]`; `stop_reason` normalized to
`ProviderResponse.kind`: `max_tokens` **and `model_context_window_exceeded`** →
`'truncated'`; `refusal` → `'refused'`; `end_turn`/`stop_sequence` → `'complete'`; other →
throw `ProviderError('malformed_response')`. Usage: base counters `input_tokens` and
`output_tokens` are REQUIRED — missing/invalid → `usage: null`; the additive optional
cache categories (`cache_creation_input_tokens`, `cache_read_input_tokens`) default 0 and
are summed into `inputTokens`. ([Anthropic usage/caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching),
[stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons))
Errors (envelope `{type:'error', error:{type,message}}`): `authentication_error` →
`auth`; `not_found_error` → `model_not_found`; `rate_limit_error`/429 → `rate_limit`;
`overloaded_error`/529/5xx → `transient`; `invalid_request_error`/400 → `invalid_request`.

## `gemini`

**`gemini({ apiKey })` — native generateContent.** `POST
https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`;
`x-goog-api-key` header. Pinned to `v1beta` deliberately: it is the channel Google's
Gemini API docs default to and where JSON-output fields live; verified by recorded
fixtures and the release live-check gate ([Gemini API](https://ai.google.dev/api/generate-content),
[API versions](https://ai.google.dev/gemini-api/docs/api-versions)). The OpenAI-compat
endpoint is not used: it is officially beta, and only the native API documents explicit
thought-token accounting (`thoughtsTokenCount`) and full termination metadata — both of
which this design depends on ([Gemini OpenAI compat](https://ai.google.dev/gemini-api/docs/openai),
[native usage fields](https://ai.google.dev/api/generate-content); the compat-usage
discrepancy observed in the research is recorded as an empirical fixture-verification item,
not the primary rationale).
Request: `contents: [{role:'user', parts:[{text: prompt}]}]`, `generationConfig:
{ maxOutputTokens?, temperature?, responseMimeType: 'application/json' }` (MIME only for
JSON-object format; prompt still carries the shape).
Response: `candidates[0].content.parts[]` text concatenated; termination normalized to
`ProviderResponse.kind`: `promptFeedback.blockReason` present → `'refused'`; no candidates
WITHOUT block metadata → throw `ProviderError('malformed_response')`; `finishReason`
`MAX_TOKENS` → `'truncated'`; any policy/filter reason (`SAFETY`, `RECITATION`,
`PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `ESCALATION`, `LANGUAGE`) → `'refused'`; `STOP` →
`'complete'`; other → throw `ProviderError('malformed_response')`. Usage: base counter
`promptTokenCount` REQUIRED (missing/invalid → `usage: null`); `outputTokens =
candidatesTokenCount + thoughtsTokenCount` where `candidatesTokenCount` is required and
`thoughtsTokenCount` is additive-optional (default 0; thinking tokens are billed output —
[thinking docs](https://ai.google.dev/gemini-api/docs/thinking)).
Errors (`{error:{code,status,message}}`): 401/403 → `auth`; 404 → `model_not_found`;
429/`RESOURCE_EXHAUSTED` → `rate_limit`; 500/503 → `transient`; 400/`INVALID_ARGUMENT` →
`invalid_request`.
