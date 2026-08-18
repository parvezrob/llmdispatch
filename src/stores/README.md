# `src/stores`

One implementation per storage backend of the two store interfaces: the config store
that holds routes and limits, and the usage store that counts quota atomically. A
store persists and reports; it never interprets a route or decides whether a run may
proceed.

May import: `src/stores`, `src/errors`, the public types, `zod`, and `node:*`
built-ins. Must not import `src/core`, `src/providers`, `src/conformance`, or an entry
module.
