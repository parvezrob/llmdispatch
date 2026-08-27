// @targets spec, package
// A route names a registered provider and a model. A missing half, a misspelt field, or a
// field the shape does not have is a configuration bug worth catching where it is written.
import type { OperationRoute } from 'llmdispatch'

// @expect TS2741
export const missingModel: OperationRoute = { provider: 'claude' }

// @expect TS2561
export const misspelt: OperationRoute = { provider: 'c', model: 'm', temperture: 1 }

// @expect TS2353
export const unknown: OperationRoute = { provider: 'c', model: 'm', retries: 3 }
