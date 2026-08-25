/**
 * `createSwitch`: validation at the edge, then the wiring of one `Switch`.
 *
 * Everything checkable without I/O is checked here, before any store call (spec §6):
 * numeric ranges with an error naming the field, the string domain for every name that can
 * reach a store, and the strict shape of every declared route. The registries are `Map`s, so
 * a hostile-but-valid name like `__proto__` is an ordinary key.
 *
 * @module
 */

import type { z } from 'zod'
import { invalidConfigLocal, invalidInput } from '../errors'
import type {
  CreateSwitchConfig,
  ModelPrice,
  OperationConfigView,
  OperationDefinition,
  OperationRoute,
  OperationsMap,
  Provider,
  QuotaView,
  RunResult,
  Switch,
} from '../types'
import { createConfigService } from './config'
import { readSnapshot } from './quota'
import type { QuotaContext } from './quota'
import type { CoreRuntime } from './runtime'
import { executeRun } from './run'
import type { RegisteredProvider, RunArguments, SwitchContext, ValidatedOperation } from './run'
import type { PricingTable } from './usage'
import {
  configTtlMsProblem,
  isRecord,
  perDayProblem,
  priceProblem,
  storeStringProblem,
  timeoutMsProblem,
  validateRoute,
} from './validate'

/** The default provider I/O timeout (spec §6). */
const DEFAULT_TIMEOUT_MS = 60_000

/** The default config cache TTL (spec §2). */
const DEFAULT_CONFIG_TTL_MS = 5000

/** The label validation uses where no single operation is at fault. */
const SWITCH_SCOPE = '*'

const FORMATS = new Set(['json', 'json-any', 'text'])

/**
 * Ties one operation's schemas to its callbacks so inference flows between them.
 *
 * Identity at runtime; the value is the correlation of `In` and `Out` across `prompt`,
 * `quality` and the run result (spec §6). Every entry handed to {@link defineOperations}
 * must be wrapped in this.
 *
 * @param definition The operation exactly as it will run.
 * @returns The same definition, its two schema types correlated.
 */
export function defineOperation<In extends z.ZodType, Out extends z.ZodType>(
  definition: OperationDefinition<In, Out>,
): OperationDefinition<In, Out> {
  return definition
}

/**
 * Collects operations for `createSwitch`.
 *
 * An identity collector (spec §6): it returns exactly the object it was given and does not
 * itself restore inference — that is {@link defineOperation}'s job, per entry.
 *
 * @param operations The map of operations, each wrapped in `defineOperation`.
 * @returns The same object.
 */
export function defineOperations<Ops extends OperationsMap>(operations: Ops): Ops {
  return operations
}

/** Validates the provider registry and answers it as a prototype-safe map. */
function validateProviders(
  providers: Record<string, Provider>,
): Map<string, RegisteredProvider> {
  const registry = new Map<string, RegisteredProvider>()
  for (const [id, provider] of Object.entries(providers)) {
    const problem = storeStringProblem(id)
    if (problem !== null) {
      throw invalidConfigLocal(SWITCH_SCOPE, `provider ID ${JSON.stringify(id)} ${problem}`)
    }
    const candidate: unknown = provider
    if (typeof candidate !== 'object' || candidate === null) {
      throw invalidConfigLocal(
        SWITCH_SCOPE,
        `providers[${JSON.stringify(id)}] must be an object`,
      )
    }
    // §5a: each callable is read once, as data, and the validated reference is what
    // dispatch runs, so mutating the registered object afterwards cannot move it.
    const complete = (candidate as { complete?: unknown }).complete
    const prepare = (candidate as { prepare?: unknown }).prepare
    if (typeof complete !== 'function') {
      throw invalidConfigLocal(
        SWITCH_SCOPE,
        `providers[${JSON.stringify(id)}].complete must be a function`,
      )
    }
    if (prepare !== undefined && typeof prepare !== 'function') {
      throw invalidConfigLocal(
        SWITCH_SCOPE,
        `providers[${JSON.stringify(id)}].prepare must be a function when present`,
      )
    }
    registry.set(id, {
      provider,
      complete: (complete as Provider['complete']).bind(provider),
    })
  }
  return registry
}

/** Validates the pricing table (spec §6: finite, ≥ 0) and answers it as nested maps. */
function validatePricing(
  pricing: Record<string, Record<string, ModelPrice>> | undefined,
): PricingTable {
  const table = new Map<string, Map<string, ModelPrice>>()
  if (pricing === undefined) return table
  for (const [providerId, models] of Object.entries(pricing)) {
    const byModel = new Map<string, ModelPrice>()
    for (const [model, price] of Object.entries(models)) {
      const label = `pricing[${JSON.stringify(providerId)}][${JSON.stringify(model)}]`
      if (!isRecord(price)) throw invalidConfigLocal(SWITCH_SCOPE, `${label} must be an object`)
      const inputProblem = priceProblem(price.inputPerM)
      if (inputProblem !== null) {
        throw invalidConfigLocal(SWITCH_SCOPE, `${label}.inputPerM ${inputProblem}`)
      }
      const outputProblem = priceProblem(price.outputPerM)
      if (outputProblem !== null) {
        throw invalidConfigLocal(SWITCH_SCOPE, `${label}.outputPerM ${outputProblem}`)
      }
      byModel.set(model, { inputPerM: price.inputPerM, outputPerM: price.outputPerM })
    }
    table.set(providerId, byModel)
  }
  return table
}

/** Validates one operation definition and answers the pieces the run needs. */
function validateOperation(
  name: string,
  definition: OperationDefinition<z.ZodType, z.ZodType>,
  registered: ReadonlySet<string>,
): ValidatedOperation {
  const nameProblem = storeStringProblem(name)
  if (nameProblem !== null) {
    throw invalidConfigLocal(name, `operation name ${nameProblem}`)
  }
  if (!isRecord(definition)) {
    throw invalidConfigLocal(name, 'operation definition must be an object')
  }
  const schemas: { field: string; value: unknown }[] = [
    { field: 'input', value: definition.input },
    { field: 'output', value: definition.output },
  ]
  for (const { field, value } of schemas) {
    const parseAsync = (value as { parseAsync?: unknown } | null | undefined)?.parseAsync
    if (typeof parseAsync !== 'function') {
      throw invalidConfigLocal(name, `${field} must be a Zod schema`)
    }
  }
  if (typeof definition.prompt !== 'function') {
    throw invalidConfigLocal(name, 'prompt must be a function')
  }
  if (definition.format !== undefined && !FORMATS.has(definition.format)) {
    throw invalidConfigLocal(name, "format must be 'json', 'json-any' or 'text'")
  }
  if (definition.quality !== undefined && typeof definition.quality !== 'function') {
    throw invalidConfigLocal(name, 'quality must be a function when present')
  }
  let quota: { perDay: number } | undefined
  if (definition.quota !== undefined) {
    if (!isRecord(definition.quota)) {
      throw invalidConfigLocal(name, 'quota must be an object when present')
    }
    const problem = perDayProblem(definition.quota.perDay)
    if (problem !== null) throw invalidConfigLocal(name, `quota.perDay ${problem}`)
    quota = { perDay: definition.quota.perDay }
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (definition.timeoutMs !== undefined) {
    const problem = timeoutMsProblem(definition.timeoutMs)
    if (problem !== null) throw invalidConfigLocal(name, `timeoutMs ${problem}`)
    timeoutMs = definition.timeoutMs
  }
  let defaultRoute: OperationRoute | undefined
  if (definition.defaultRoute !== undefined) {
    const checked = validateRoute(definition.defaultRoute, registered)
    if (!checked.ok) throw invalidConfigLocal(name, `defaultRoute ${checked.problem}`)
    defaultRoute = checked.value
  }
  return { definition, quota, timeoutMs, defaultRoute }
}

/**
 * Builds a configured switch (spec §6).
 *
 * Pure wiring plus §6 validation; no store is called and no provider is prepared here.
 * Internal — the public `createSwitch` in the root entry supplies the real runtime.
 *
 * @throws `LLMSwitchError` with code `INVALID_CONFIG` naming the field that failed.
 */
export function createSwitchCore<Ops extends OperationsMap>(
  config: CreateSwitchConfig<Ops>,
  runtime: CoreRuntime,
): Switch<Ops> {
  const candidate: unknown = config
  if (typeof candidate !== 'object' || candidate === null) {
    throw invalidConfigLocal(SWITCH_SCOPE, 'config must be an object')
  }
  if (config.configTtlMs !== undefined) {
    const problem = configTtlMsProblem(config.configTtlMs)
    if (problem !== null) throw invalidConfigLocal(SWITCH_SCOPE, `configTtlMs ${problem}`)
  }
  const stores = config.stores as { config?: unknown; usage?: unknown } | undefined
  if (typeof stores?.config !== 'object' || stores.config === null) {
    throw invalidConfigLocal(SWITCH_SCOPE, 'stores.config must be a ConfigStore')
  }
  if (typeof stores.usage !== 'object' || stores.usage === null) {
    throw invalidConfigLocal(SWITCH_SCOPE, 'stores.usage must be a UsageStore')
  }

  const providers = validateProviders(config.providers)
  const registered = new Set(providers.keys())
  const pricing = validatePricing(config.pricing)

  const operations = new Map<string, ValidatedOperation>()
  for (const [name, definition] of Object.entries(config.operations)) {
    operations.set(name, validateOperation(name, definition, registered))
  }

  const configService = createConfigService({
    runtime,
    store: config.stores.config,
    configTtlMs: config.configTtlMs ?? DEFAULT_CONFIG_TTL_MS,
    operations: new Map(
      [...operations].map(([name, op]) => [name, { defaultRoute: op.defaultRoute }]),
    ),
    registered,
  })

  const ctx: SwitchContext = {
    runtime,
    providers,
    operations,
    configService,
    usageStore: config.stores.usage,
    pricing,
    treatUnclassifiedAsTransient: config.treatUnclassifiedAsTransient ?? false,
    fallbackOnAuthOrModelNotFound: config.fallbackOnAuthOrModelNotFound ?? false,
    onSettlementError: config.onSettlementError,
    logger: config.logger,
  }

  const requireOperation = (operation: string): ValidatedOperation => {
    const op = operations.get(operation)
    if (op === undefined) throw invalidInput(operation, 'unknown operation')
    return op
  }

  async function getQuota(operation: string, subjectId: string): Promise<QuotaView> {
    // The §2 precedence, in order; the string-domain check runs before `snapshot`.
    const op = requireOperation(operation)
    if (typeof subjectId !== 'string' || subjectId === '') {
      throw invalidInput(operation, 'subjectId must be a non-empty string')
    }
    const domainProblem = storeStringProblem(subjectId)
    if (domainProblem !== null) throw invalidInput(operation, `subjectId ${domainProblem}`)
    const route = await configService.resolve(operation)
    const quota = route.quota ?? op.quota
    if (quota === undefined) throw invalidInput(operation, 'no effective quota')
    const quotaCtx: QuotaContext = {
      runtime,
      store: config.stores.usage,
      operation,
      signal: undefined,
    }
    const snapshot = await readSnapshot(quotaCtx, { operation, subjectId })
    return {
      limit: quota.perDay,
      used: snapshot.used,
      remaining: Math.max(0, quota.perDay - snapshot.used),
      resetsAt: snapshot.resetsAt,
    }
  }

  const run = (
    operation: string,
    args: RunArguments,
    options?: { signal?: AbortSignal },
  ): Promise<RunResult<unknown>> => executeRun(ctx, operation, args, options)

  const admin = {
    getConfig: async (): Promise<Record<string, OperationConfigView>> => configService.view(),
    setConfig: async (operation: string, route: OperationRoute): Promise<void> => {
      requireOperation(operation)
      const checked = validateRoute(route, registered)
      if (!checked.ok) throw invalidConfigLocal(operation, `route ${checked.problem}`)
      await configService.set(operation, checked.value)
    },
    resetConfig: async (operation: string): Promise<void> => {
      requireOperation(operation)
      await configService.reset(operation)
    },
    getQuota,
  }

  return { run, ...admin } as unknown as Switch<Ops>
}
