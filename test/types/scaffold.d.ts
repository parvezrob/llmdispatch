// The one value a README example uses without introducing it: the backend a custom
// provider adapter calls. Declaring it here is what lets that example be compiled exactly
// as it is printed, rather than as a paraphrase with the missing piece filled in. (The
// quickstart needs no scaffold: its fence is self-contained, and the fixture checker
// compiles it straight out of README.md.)

import type { ProviderRequest, TokenUsage } from 'llmswitch'

declare global {
  /** The backend the README's custom provider adapter calls. */
  function callMyBackend(req: ProviderRequest): Promise<{
    status: number
    body: string
    cutOff: boolean
    tokens: TokenUsage | null
  }>
}
