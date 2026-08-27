# `src/errors`

The two error classes adopters see. `LLMDispatchError` is what a classified failure raises: a
closed `code` union, a private constructor, and a `retryable` flag that is the literal of the
spec §5b classification row rather than of the code — `PROVIDER_FAILED` is retryable for a
`transient` failure and not for a `refused` one, which is why there is one typed factory per
classification. `ProviderError` is what an adapter throws to say how a call failed; it is
recognised by a brand on its prototype, never by `instanceof`, so it still classifies
correctly when the thrower and the reader loaded different copies of the package.

The factories stay internal. Messages are stable and carry no prompt, model output, or raw
provider error.

May import: the public types in `src/types.ts`, `src/errors` itself, and `zod`. This is the
bottom layer of behaviour — nothing else in `src` may be imported from here, so every other
folder can depend on it without creating a cycle.
