# Recorded fixtures

## `openai-chat-completion.json`

The response body shape of a successful OpenAI `POST /v1/chat/completions` call, as the
built-in `openaiCompatible` adapter reads it. `scripts/verify-examples.mjs` serves it from
a local fixture server so the examples can run end to end without a provider key.

Only the **shape** is recorded. Every value here is synthetic: identifiers are zeroed,
counters are zero, `content` is empty, and no header, request id, prompt or model output
from any real call is stored. The harness fills `model` and `choices[0].message.content`
per run, deriving the content from that run's nonce, so a response can only have come from
this fixture during this run.

Refresh it from the provider's published response schema — never by pasting a captured
transcript.
