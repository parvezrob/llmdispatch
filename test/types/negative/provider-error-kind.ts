// @targets spec, package
// The classification set is closed: an adapter cannot invent a kind, because the fallback
// matrix has no row for one.
import { ProviderError } from 'llmdispatch'

// @expect TS2345
export const invented = new ProviderError('overloaded')

// @expect TS2345
export const wrongCase = new ProviderError('RATE_LIMIT', { status: 429 })
