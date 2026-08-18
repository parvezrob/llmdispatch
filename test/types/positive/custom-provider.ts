// @targets spec, package
// The README's custom provider adapter, compiled as it is printed there. It is the shape
// every adopter writing their own transport starts from, so both the interface it
// implements and the error it throws have to be reachable from the package root.
import { ProviderError, type Provider } from 'llmswitch'

export const myProvider: Provider = {
  async complete(req) {
    const res = await callMyBackend(req) // req.responseFormat tells you text vs JSON
    if (res.status === 429) throw new ProviderError('rate_limit', { status: 429 })
    if (res.status === 401) throw new ProviderError('auth', { status: 401 })
    if (res.cutOff) return { kind: 'truncated', text: res.body, usage: res.tokens ?? null }
    return { kind: 'complete', text: res.body, usage: res.tokens ?? null } // usage null if unreported
  },
}
