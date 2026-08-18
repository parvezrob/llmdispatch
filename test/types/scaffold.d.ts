// The values the README examples use without introducing them: the article being
// summarized, the signed-in user, and the backend a custom provider adapter calls.
// Declaring them here is what lets those examples be compiled exactly as they are printed,
// rather than as a paraphrase with the missing pieces filled in.

import type { ProviderRequest, TokenUsage } from 'llmswitch'

declare global {
  /** The text passed to the quickstart's `summarize` operation. */
  const articleText: string

  /** The signed-in user, whose ID is the quota subject. */
  const user: { id: string }

  /** The backend the README's custom provider adapter calls. */
  function callMyBackend(req: ProviderRequest): Promise<{
    status: number
    body: string
    cutOff: boolean
    tokens: TokenUsage | null
  }>
}
