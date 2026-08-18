# `src/conformance`

The harnesses published under `llmswitch/conformance`. They exercise a provider, usage
store or config store purely through its public interface and report which behaviours
hold, so anyone can prove a custom implementation is substitutable for a built-in one.

May import: `src/conformance`, `src/errors`, the public types, `zod`, and `node:*`
built-ins. Must not import a concrete provider or store — a harness that reached for a
built-in would test the built-in instead of the implementation under test.
