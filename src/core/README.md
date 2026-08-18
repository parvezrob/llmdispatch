# `src/core`

The decision layer: the run state machine, config resolution and caching, failure
classification, and the quota lifecycle. Everything here is pure — it decides _what_
should happen and hands the work to an interface it never implements itself. No HTTP,
no SQL, no clock reads that are not passed in, no Node built-ins at all.

May import: `src/core`, `src/errors`, the public types, and `zod`. Must not import
`src/providers`, `src/stores`, `src/conformance`, or an entry module — adding a
provider or a store never edits this folder.
