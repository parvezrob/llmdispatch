---
'llmdispatch': minor
---

A route's `provider` or `model` that starts or ends with whitespace is now rejected instead of sent to the provider as written, where it usually failed as a provider error. This rejects configs that were accepted before: a declared `defaultRoute` or fallback fails `createSwitch` with `INVALID_CONFIG`, `setConfig` throws `INVALID_CONFIG`, and a stored row carrying one is a malformed row, so runs of that operation fail with `INVALID_CONFIG` (it does not fall back to `defaultRoute`) and `getConfig()` reports it as `stored: 'malformed'`. The message names the field, for example `model must not start or end with whitespace`. The fix is to remove the space from the name; for a stored row, write the route again with `setConfig`. Whitespace inside a model ID is still accepted and sent unchanged.
