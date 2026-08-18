# `src/providers`

One adapter per provider API. Each translates a request into that provider's wire
format, sends it with global `fetch`, and translates the response — or the failure —
back into the shared shapes. An adapter decides nothing about routing, fallback, or
quotas; it reports what happened and lets the core decide.

May import: `src/providers`, `src/errors`, the public types, `zod`, and `node:*`
built-ins. Must not import `src/core`, `src/stores`, `src/conformance`, or an entry
module.
