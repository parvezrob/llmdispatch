/**
 * The run state machine: spec §1's eleven stages, in order, with nothing between them.
 *
 * The shape of the file follows the spec: `executeRun` is the staged walk to a committed
 * slot, `runAttempts` is stages 9–10 inside the finalization `try/finally`, and
 * `executeAttempt` is one dispatch through the §3 output pipeline. Abort is checked at every
 * stage boundary and raced across every awaited user callback; reserve and commit are the
 * §1 exception and are always awaited to their deadline-bounded result first.
 *
 * @module
 */

import type { z } from 'zod'
import {
  aborted,
  invalidConfigLocal,
  invalidConfigProvider,
  invalidConfigTransientPrepare,
  invalidInput,
  missingSubject,
  outputRejected,
  providerFailed,
  ProviderError,
} from '../errors'
import type { LLMSwitchError } from '../errors'
import type { ProviderFailureKind } from '../errors/factories'
import type {
  AttemptRecord,
  Logger,
  OperationDefinition,
  OperationRoute,
  PreparedProvider,
  Provider,
  ProviderRequest,
  QuotaKey,
  ReservationEnvelope,
  RouteTarget,
  RunResult,
  SettlementFailure,
  UsageStore,
} from '../types'
import { AbortRaceLost, raceWithAbort } from './abort'
import type { AttemptFailureKind } from './classify'
import { classifyThrown, isFallbackEligible } from './classify'
import type { ConfigService } from './config'
import { isZodError, processOutput } from './output'
import { commitWithRecovery, reserveSlot, settleDetached } from './quota'
import type { QuotaContext } from './quota'
import type { CoreRuntime } from './runtime'
import type { PricingTable } from './usage'
import { aggregateAttempts, normalizeUsage, priceAttempt } from './usage'
import { isRecord, storeStringProblem } from './validate'

/** One declared operation, as `createSwitch` validated and stored it. */
export interface ValidatedOperation {
  definition: OperationDefinition<z.ZodType, z.ZodType>
  quota: { perDay: number } | undefined
  timeoutMs: number
  defaultRoute: OperationRoute | undefined
}

/** Everything a run needs, assembled once by `createSwitch`. */
export interface SwitchContext {
  runtime: CoreRuntime
  providers: ReadonlyMap<string, Provider>
  operations: ReadonlyMap<string, ValidatedOperation>
  configService: ConfigService
  usageStore: UsageStore
  pricing: PricingTable
  treatUnclassifiedAsTransient: boolean
  fallbackOnAuthOrModelNotFound: boolean
  onSettlementError:
    ((error: unknown, record: SettlementFailure) => void | Promise<void>) | undefined
  logger: Logger | undefined
}

/** What the public `run` hands over after its own typing. */
export interface RunArguments {
  input: unknown
  subjectId?: string | undefined
}

/** A deep-enough copy: attempt records and their usage objects are what callers can reach. */
function copyAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  return attempts.map((attempt) => ({
    ...attempt,
    usage: attempt.usage === null ? null : { ...attempt.usage },
  }))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Maps a final attempt's classification to its §5b terminal error. */
function terminalFor(
  operation: string,
  kind: Exclude<AttemptFailureKind, 'output_schema_error' | 'quality_error'>,
  attempts: AttemptRecord[],
): LLMSwitchError {
  switch (kind) {
    case 'transient':
    case 'rate_limit':
    case 'malformed_response':
    case 'timeout':
    case 'refused':
    case 'invalid_request':
    case 'provider_unclassified':
      return providerFailed(operation, kind satisfies ProviderFailureKind, attempts)
    case 'truncated':
    case 'output_rejected':
      return outputRejected(operation, kind, attempts)
    case 'auth':
    case 'model_not_found':
      // §5a: `detectedAt: 'provider'` exactly when the final attempt ended here.
      return invalidConfigProvider(operation, attempts)
    case 'aborted':
      return aborted(operation, attempts)
  }
}

/**
 * Runs one operation end to end (spec §1).
 *
 * @throws `LLMSwitchError` per the stage table and §5b, or the user's own exception raw
 *   (stages 2 and 6 pre-quota; `output_schema_error`/`quality_error` post-dispatch, settled
 *   first).
 */
export async function executeRun(
  ctx: SwitchContext,
  operation: string,
  args: RunArguments,
  options?: { signal?: AbortSignal },
): Promise<RunResult<unknown>> {
  const signal = options?.signal
  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw aborted(operation)
  }

  // Stage 0: signal already aborted.
  throwIfAborted()

  // Stage 1: operation lookup.
  const op = ctx.operations.get(operation)
  if (op === undefined) throw invalidInput(operation, 'unknown operation')
  throwIfAborted()

  // Stage 2: input parse. ZodError is validation; anything else is the user's bug, raw.
  let parsedInput: unknown
  try {
    parsedInput = await raceWithAbort(op.definition.input.parseAsync(args.input), signal)
  } catch (error) {
    if (error instanceof AbortRaceLost) throw aborted(operation)
    if (isZodError(error))
      throw invalidInput(operation, 'input failed the operation input schema')
    throw error
  }
  throwIfAborted()

  // Stage 3: subject check for a declared quota only — it must precede all I/O.
  const subjectId = args.subjectId
  if (op.quota !== undefined && !isNonEmptyString(subjectId)) throw missingSubject(operation)
  throwIfAborted()

  // Stage 4: config resolution for both routes in one read, then the route-enabled subject
  // check — after config errors, per the §1 precedence rule.
  const route = await ctx.configService.resolve(operation)
  const effectiveQuota = route.quota ?? op.quota
  if (effectiveQuota !== undefined && !isNonEmptyString(subjectId))
    throw missingSubject(operation)
  throwIfAborted()

  // Stage 5: readiness for both routes, memoized per provider registration ID.
  const dispatchers = await prepareDispatchers(ctx, operation, route, signal)
  throwIfAborted()

  // Stage 6: prompt build. A non-string return is the user's bug, as is anything thrown.
  let promptValue: unknown
  try {
    promptValue = await raceWithAbort(
      Promise.resolve(op.definition.prompt(parsedInput)),
      signal,
    )
  } catch (error) {
    if (error instanceof AbortRaceLost) throw aborted(operation)
    throw error
  }
  if (typeof promptValue !== 'string') {
    throw new TypeError(
      `the prompt callback for operation "${operation}" must return a string; it returned a value of type ${typeof promptValue}`,
    )
  }
  const prompt = promptValue
  throwIfAborted()

  // Stages 7 and 8: reserve and commit, only for an effective quota. Neither is raced with
  // the signal — an in-flight call is awaited to its deadline-bounded result first (§1).
  let envelope: ReservationEnvelope | null = null
  if (effectiveQuota !== undefined) {
    // Re-narrowing only: the stage 3/4 checks above already threw for a missing subject.
    if (!isNonEmptyString(subjectId)) throw missingSubject(operation)
    const problem = storeStringProblem(subjectId)
    if (problem !== null) throw invalidInput(operation, `subjectId ${problem}`)
    const key: QuotaKey = { operation, subjectId }
    const quotaCtx: QuotaContext = {
      runtime: ctx.runtime,
      store: ctx.usageStore,
      operation,
      signal,
    }
    envelope = await reserveSlot(quotaCtx, key, effectiveQuota.perDay)
    // Abort after the awaited reserve: pre-commit, so the pending slot expires on its own.
    throwIfAborted()
    envelope = await commitWithRecovery(quotaCtx, envelope, key, effectiveQuota.perDay)
  }

  // Post-commit region: from here, every return or throw settles first (§1 stage 11).
  const attempts: AttemptRecord[] = []
  let succeeded = false
  try {
    const result = await runAttempts(ctx, op, operation, route, dispatchers, {
      prompt,
      parsedInput,
      signal,
      attempts,
    })
    succeeded = true
    return result
  } finally {
    if (envelope !== null) {
      await settleDetached(
        {
          runtime: ctx.runtime,
          store: ctx.usageStore,
          onSettlementError: ctx.onSettlementError,
          logger: ctx.logger,
        },
        envelope,
        succeeded ? 'succeeded' : 'failed',
        copyAttempts(attempts),
      )
    }
  }
}

/**
 * Stage 5: registration plus `prepare()`, once per unique provider registration ID for the
 * run, returning the run-scoped dispatchers (spec §5a). Nothing is stored on the shared
 * provider; concurrent runs each hold their own map.
 */
async function prepareDispatchers(
  ctx: SwitchContext,
  operation: string,
  route: OperationRoute,
  signal: AbortSignal | undefined,
): Promise<Map<string, PreparedProvider>> {
  const ids = [route.provider]
  const fallbackProvider = route.fallback?.provider
  if (fallbackProvider !== undefined && !ids.includes(fallbackProvider)) {
    ids.push(fallbackProvider)
  }
  const dispatchers = new Map<string, PreparedProvider>()
  for (const id of ids) {
    const provider = ctx.providers.get(id)
    if (provider === undefined) {
      throw invalidConfigLocal(operation, `provider "${id}" is not registered`)
    }
    const prepare = provider.prepare?.bind(provider)
    if (prepare === undefined) {
      dispatchers.set(id, { complete: (request) => provider.complete(request) })
      continue
    }
    let prepared: unknown
    try {
      prepared = await raceWithAbort((async () => await prepare())(), signal)
    } catch (error) {
      if (error instanceof AbortRaceLost) throw aborted(operation)
      // §5a failure mapping. The kind is read once; a second-read game cannot move it.
      if (ProviderError.is(error)) {
        let kind: unknown
        try {
          kind = error.kind
        } catch {
          kind = undefined
        }
        if (kind === 'transient') throw invalidConfigTransientPrepare(operation, error)
      }
      throw invalidConfigLocal(operation, `provider "${id}" could not be prepared`, {
        cause: error,
      })
    }
    if (!isRecord(prepared) || typeof prepared.complete !== 'function') {
      throw invalidConfigLocal(
        operation,
        `provider "${id}" prepare() returned no complete function`,
      )
    }
    dispatchers.set(id, prepared as unknown as PreparedProvider)
  }
  return dispatchers
}

/** How one attempt ended, as the state machine consumes it. */
type AttemptEnd =
  | { type: 'success'; data: unknown }
  | {
      type: 'failed'
      kind: Exclude<AttemptFailureKind, 'output_schema_error' | 'quality_error'>
    }
  | { type: 'user-error'; error: unknown }

/** What every attempt shares: built once by stage 6 and earlier. */
interface AttemptShared {
  prompt: string
  parsedInput: unknown
  signal: AbortSignal | undefined
  attempts: AttemptRecord[]
}

/** Stages 9 and 10: the primary attempt, the fallback decision, and the terminal outcome. */
async function runAttempts(
  ctx: SwitchContext,
  op: ValidatedOperation,
  operation: string,
  route: OperationRoute,
  dispatchers: ReadonlyMap<string, PreparedProvider>,
  shared: AttemptShared,
): Promise<RunResult<unknown>> {
  const { signal, attempts } = shared
  const abortedWithAttempts = (): LLMSwitchError => aborted(operation, copyAttempts(attempts))
  // A helper, not an inline read: the checks repeat, and TypeScript would otherwise narrow
  // `signal.aborted` to `false` after the first throw even though it changes over time.
  const callerAborted = (): boolean => signal?.aborted === true

  const buildResult = (
    data: unknown,
    target: RouteTarget,
    usedFallback: boolean,
  ): RunResult<unknown> => {
    const aggregate = aggregateAttempts(attempts)
    return {
      data,
      route: { provider: target.provider, model: target.model },
      usedFallback,
      attempts: copyAttempts(attempts),
      usage: aggregate.usage,
      usageComplete: aggregate.usageComplete,
      cost: aggregate.cost,
    }
  }

  // Stage 9: final signal check immediately before dispatch.
  if (callerAborted()) throw abortedWithAttempts()
  const primaryTarget: RouteTarget = { provider: route.provider, model: route.model }
  if (route.maxOutputTokens !== undefined) primaryTarget.maxOutputTokens = route.maxOutputTokens
  if (route.temperature !== undefined) primaryTarget.temperature = route.temperature
  const primary = await executeAttempt(ctx, op, dispatchers, primaryTarget, shared)
  if (primary.type === 'success') return buildResult(primary.data, primaryTarget, false)
  if (primary.type === 'user-error') {
    // Only an abort after a SUCCESSFUL attempt is outcome-immune (§1): at this boundary a
    // fired signal wins over the user's error. Finalization still settles, as 'failed'.
    if (callerAborted()) throw abortedWithAttempts()
    throw primary.error // settled by finalization first
  }
  if (primary.kind === 'aborted') throw abortedWithAttempts()

  // Stage 10 boundary: the abort rule wins over the fallback decision.
  if (callerAborted()) throw abortedWithAttempts()
  const fallbackTarget = route.fallback ?? null
  if (
    fallbackTarget !== null &&
    isFallbackEligible(primary.kind, {
      isPrimary: true,
      fallbackOnAuthOrModelNotFound: ctx.fallbackOnAuthOrModelNotFound,
    })
  ) {
    // Same sub-stages, fresh provider timeout, at most once (§1 stage 10).
    const fallback = await executeAttempt(ctx, op, dispatchers, fallbackTarget, shared)
    if (fallback.type === 'success') return buildResult(fallback.data, fallbackTarget, true)
    if (fallback.type === 'user-error') {
      if (callerAborted()) throw abortedWithAttempts()
      throw fallback.error
    }
    if (fallback.kind === 'aborted') throw abortedWithAttempts()
    if (callerAborted()) throw abortedWithAttempts()
    throw terminalFor(operation, fallback.kind, copyAttempts(attempts))
  }
  if (callerAborted()) throw abortedWithAttempts()
  throw terminalFor(operation, primary.kind, copyAttempts(attempts))
}

/** What reading a `ProviderResponse` produced, with the body left untouched until needed. */
type ReadResponse =
  | { kind: 'complete'; text: string; usage: AttemptRecord['usage'] }
  | { kind: 'truncated' | 'refused'; usage: AttemptRecord['usage'] }
  | { kind: 'malformed'; usage: AttemptRecord['usage'] }

/**
 * Validates a resolved `ProviderResponse` (spec §3, §6).
 *
 * Termination before content: `kind` is read first, and for `'truncated'`/`'refused'` the
 * body is never touched — those classify on the termination alone, usage retained. Every
 * property is read once, behind a guard, so a hostile response classifies
 * `malformed_response` rather than throwing into the state machine.
 */
function readResponse(response: unknown): ReadResponse {
  try {
    if (!isRecord(response)) return { kind: 'malformed', usage: null }
    const kind = response.kind
    if (kind === 'truncated' || kind === 'refused') {
      return { kind, usage: normalizeUsage(response.usage) }
    }
    if (kind === 'complete') {
      const usage = normalizeUsage(response.usage)
      const text = response.text
      if (typeof text !== 'string') return { kind: 'malformed', usage }
      return { kind: 'complete', text, usage }
    }
    return { kind: 'malformed', usage: normalizeUsage(response.usage) }
  } catch {
    return { kind: 'malformed', usage: null }
  }
}

/** The §3 `responseFormat` for an operation's declared `format` (default `'json'`). */
function responseFormatOf(
  format: 'json' | 'json-any' | 'text' | undefined,
): ProviderRequest['responseFormat'] {
  if (format === 'text') return { type: 'text' }
  if (format === 'json-any') return { type: 'json', topLevel: 'any' }
  return { type: 'json', topLevel: 'object' }
}

/**
 * One attempt: compose the signal, dispatch through the run-scoped dispatcher, and run the
 * output pipeline. Records exactly one `AttemptRecord`, whose `outcome` is the
 * classification this function answers with (the §2 call-site invariant).
 */
async function executeAttempt(
  ctx: SwitchContext,
  op: ValidatedOperation,
  dispatchers: ReadonlyMap<string, PreparedProvider>,
  target: RouteTarget,
  shared: AttemptShared,
): Promise<AttemptEnd> {
  const { runtime } = ctx
  const { signal, attempts } = shared
  let durationMs = 0

  function record(
    outcome: AttemptRecord['outcome'],
    usage: AttemptRecord['usage'],
    status?: number,
  ): void {
    const attempt: AttemptRecord = {
      provider: target.provider,
      model: target.model,
      outcome,
      usage,
      costUsd: priceAttempt(ctx.pricing, target.provider, target.model, usage),
      durationMs,
    }
    if (status !== undefined) attempt.status = status
    attempts.push(attempt)
  }

  function recordAndFail(
    kind: Exclude<AttemptFailureKind, 'output_schema_error' | 'quality_error'>,
    status: number | undefined,
    usage: AttemptRecord['usage'] = null,
  ): AttemptEnd {
    record(kind, usage, status)
    return { type: 'failed', kind }
  }

  const dispatcher = dispatchers.get(target.provider)
  if (dispatcher === undefined) {
    // Unreachable: stage 5 prepared every routed provider. Classified, never thrown.
    return recordAndFail('provider_unclassified', undefined)
  }

  // One composed signal: the caller's, plus the per-attempt `timeoutMs`, which races
  // `complete()` only (§3 pt 8). Fresh for every attempt.
  const controller = new AbortController()
  let resolveTimeout: ((value: 'timeout') => void) | undefined
  const timeoutFired = new Promise<'timeout'>((resolve) => {
    resolveTimeout = resolve
  })
  let resolveCallerAbort: ((value: 'caller-abort') => void) | undefined
  const callerAbortFired = new Promise<'caller-abort'>((resolve) => {
    resolveCallerAbort = resolve
  })
  const timerHandle = runtime.schedule(
    () => {
      resolveTimeout?.('timeout')
      controller.abort()
    },
    op.timeoutMs,
    'referenced',
  )
  const onCallerAbort = (): void => {
    resolveCallerAbort?.('caller-abort')
    controller.abort()
  }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  const dispose = (): void => {
    runtime.cancel(timerHandle)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  const request: ProviderRequest = {
    prompt: shared.prompt,
    model: target.model,
    responseFormat: responseFormatOf(op.definition.format),
    signal: controller.signal,
  }
  if (target.maxOutputTokens !== undefined) request.maxOutputTokens = target.maxOutputTokens
  if (target.temperature !== undefined) request.temperature = target.temperature

  const startedAt = runtime.now()
  const dispatch = (async () => await dispatcher.complete(request))()
  const raced = await Promise.race([
    dispatch.then(
      (response) => ({ type: 'response' as const, response }),
      (error: unknown) => ({ type: 'thrown' as const, error }),
    ),
    timeoutFired,
    callerAbortFired,
  ])
  // durationMs is the provider I/O time: dispatch to settlement of the race, on the
  // injected clock. Output processing is not bounded by `timeoutMs` and not counted here.
  durationMs = runtime.now() - startedAt
  dispose()

  // §5b: the core classifies from its own flags regardless of adapter cooperation.
  if (raced === 'caller-abort') return recordAndFail('aborted', undefined)
  if (raced === 'timeout') return recordAndFail('timeout', undefined)

  if (raced.type === 'thrown') {
    const classified = classifyThrown(raced.error, {
      callerAborted: signal?.aborted === true,
      treatUnclassifiedAsTransient: ctx.treatUnclassifiedAsTransient,
    })
    return recordAndFail(classified.kind, classified.status)
  }

  const read = readResponse(raced.response)
  if (read.kind !== 'complete') {
    if (read.kind === 'malformed') {
      return recordAndFail('malformed_response', undefined, read.usage)
    }
    return recordAndFail(read.kind, undefined, read.usage)
  }

  const output = await processOutput(read.text, op.definition, shared.parsedInput, signal)
  switch (output.type) {
    case 'success':
      record('succeeded', read.usage)
      return { type: 'success', data: output.data }
    case 'rejected':
      return recordAndFail('output_rejected', undefined, read.usage)
    case 'aborted':
      return recordAndFail('aborted', undefined, read.usage)
    case 'user-error':
      record(output.outcome, read.usage)
      return { type: 'user-error', error: output.error }
  }
}
