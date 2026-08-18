# `src/errors`

The error surface adopters catch: one error class with a closed `code` union, the
literal `retryable` flag that goes with each code, and the typed factories every throw
site uses. Messages are stable and carry no prompt, model output, or raw provider
error.

May import: `src/errors`, the public types, and `zod`. This is the bottom layer —
nothing else in `src` may be imported from here, so every other folder can depend on
it without creating a cycle.
