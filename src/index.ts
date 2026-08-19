/**
 * Root entry point — `import { … } from 'llmswitch'`.
 *
 * The only module that assembles the pieces: the factory that turns providers, operations
 * and stores into a working switch, the built-in adapters, the in-memory stores, the errors,
 * and the types describing them. The surface is spec §6, listed name by name rather than
 * re-exported wholesale so a new declaration cannot reach adopters by accident. The package
 * is pre-release; the remaining values land before the first publish.
 *
 * @module
 */

export type {
  OperationsMap,
  Switch,
  CreateSwitchConfig,
  SettlementFailure,
  StorePair,
  Logger,
  OperationDefinition,
  QualityVerdict,
  OperationRoute,
  RouteTarget,
  OperationConfigView,
  QuotaView,
  RunResult,
  AttemptOutcome,
  AttemptRecord,
  TokenUsage,
  ModelPrice,
  Provider,
  PreparedProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderErrorKind,
  ApiKeyResolver,
  ConfigStore,
  QuotaKey,
  ReservationEnvelope,
  UsageStore,
} from './types'

export { LLMSwitchError, ProviderError } from './errors'
export { memoryStores } from './stores/memory'
