---
'llmdispatch': patch
---

`openaiCompatible` on an OpenRouter host now recognises OpenRouter's documented error vocabulary: its moderation answer (a 403 carrying `reasons` and `flagged_input` metadata) and the `content_policy_violation` and `refusal` types count as moderation, and the `error_type` word is read from any of its three documented places, so `permission_denied` classifies as `auth` and `payment_required` and `rate_limit_exceeded` as `rate_limit`.
