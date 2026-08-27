# Inputs the tree scanner must stay quiet about

These sit in the repository on purpose: they are scanned like every other tracked file, so
if a rule ever became too eager, an ordinary run would say so. Deliberately matching
inputs are never committed — the scanner's self-test builds those in a temporary directory
and deletes them.

An address in the documentation domain: reader@example.com

Links to hosts on the allowlist: <https://nodejs.org/en/download> and
<https://github.com/parvezrob/llmdispatch>.

An ordinary relative import, which must not read as a path alias:

```ts
import { createSwitch } from './core/switch.js'
```

A word that contains a marker without being one: `xxxlarge` is a size, not a note to self.
