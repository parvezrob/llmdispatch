/**
 * Root entry point. `import { … } from 'llmdispatch'`.
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
  TextPart,
  FilePart,
  ContentPart,
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

import { createSwitchCore } from './core/create-switch'
import { createGlobalRuntime } from './runtime'
import type { CreateSwitchConfig, OperationsMap, Switch } from './types'

export { LLMDispatchError, ProviderError } from './errors'
export { anthropic } from './providers/anthropic'
export { openaiCompatible } from './providers/openai-compatible'
export { gemini } from './providers/gemini'
export { memoryStores } from './stores/memory'
export { postgresStores } from './stores/postgres'
export { defineOperation, defineOperations } from './core/create-switch'

/**
 * Builds a configured switch: providers, operations and stores in; `run` plus the admin
 * surface out (spec §6).
 *
 * Construction is pure wiring: no store is called, no provider is prepared, no network is
 * touched, plus the §6 validation of every range and name, so a misconfiguration fails
 * here, loudly, rather than on the first request.
 *
 * @param config Who can be called, what the app does, and where config and counters live.
 * @throws `LLMDispatchError` with code `INVALID_CONFIG` naming the field that failed.
 * @example
 * ```ts
 * const ai = createSwitch({ providers, operations, stores: memoryStores() })
 * const result = await ai.run('summarize', { input: { text }, subjectId: user.id })
 * ```
 */
export function createSwitch<Ops extends OperationsMap>(
  config: CreateSwitchConfig<Ops>,
): Switch<Ops> {
  return createSwitchCore(config, createGlobalRuntime())
}
