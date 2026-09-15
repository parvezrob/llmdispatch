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
import type { LLMDispatchError } from '../errors'
import type { ProviderFailureKind } from '../errors/factories'
import type {
  AttemptRecord,
  ContentPart,
  GeneratedImage,
  ImageOptions,
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
import { readImageDimensions } from './image-header'
import { IMAGE_MEDIA_TYPES } from './image-output'
import { base64Problem, normalizePromptParts } from './parts'
import type { OutputFormat, PricingTable } from './usage'
import { aggregateAttempts, normalizeUsage, priceAttempt } from './usage'
import { isCount, isRecord, storeStringProblem } from './validate'

/** One declared operation, as `createSwitch` validated and stored it. */
export interface ValidatedOperation {
  definition: OperationDefinition<z.ZodType, z.ZodType>
  /** The declared format, defaulted; the run reads this, never `definition.format`. */
  format: OutputFormat
  /** The validated image knobs, frozen, only the ones set; `undefined` outside image format. */
  image: Readonly<ImageOptions> | undefined
  quota: { perDay: number } | undefined
  timeoutMs: number
  defaultRoute: OperationRoute | undefined
}

/**
 * A provider as registered, with the `complete` `createSwitch` validated bound to it.
 *
 * Readiness is decided once (§5a); `provider` is retained only for the per-run
 * `prepare()` read.
 */
export interface RegisteredProvider {
  provider: Provider
  complete: PreparedProvider['complete']
}

/** Everything a run needs, assembled once by `createSwitch`. */
export interface SwitchContext {
  runtime: CoreRuntime
  providers: ReadonlyMap<string, RegisteredProvider>
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
): LLMDispatchError {
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
 * @throws `LLMDispatchError` per the stage table and §5b, or the user's own exception raw
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

  // Stage 3: subject check for a declared quota only: it must precede all I/O.
  const subjectId = args.subjectId
  if (op.quota !== undefined && !isNonEmptyString(subjectId)) throw missingSubject(operation)
  throwIfAborted()

  // Stage 4: config resolution for both routes in one read, then the route-enabled subject
  // check, after config errors, per the §1 precedence rule.
  const route = await ctx.configService.resolve(operation)
  const effectiveQuota = route.quota ?? op.quota
  if (effectiveQuota !== undefined && !isNonEmptyString(subjectId))
    throw missingSubject(operation)
  throwIfAborted()

  // Stage 5: readiness for both routes, memoized per provider registration ID.
  const dispatchers = await prepareDispatchers(ctx, operation, route, signal)
  throwIfAborted()

  // Stage 6: prompt build. A return that is neither a string nor well-formed content parts
  // is the user's bug, as is anything thrown. Normalization precedes stage 7, so a bad
  // prompt never reserves a slot.
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
  const parts = normalizePromptParts(promptValue, operation)
  throwIfAborted()

  // Stages 7 and 8: reserve and commit, only for an effective quota. Neither is raced with
  // the signal: an in-flight call is awaited to its deadline-bounded result first (§1).
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
      parts,
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
    const registered = ctx.providers.get(id)
    if (registered === undefined) {
      throw invalidConfigLocal(operation, `provider "${id}" is not registered`)
    }
    const { provider } = registered
    const prepare = provider.prepare?.bind(provider)
    if (prepare === undefined) {
      dispatchers.set(id, { complete: registered.complete })
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
    const complete = isRecord(prepared) ? prepared.complete : undefined
    if (typeof complete !== 'function') {
      throw invalidConfigLocal(
        operation,
        `provider "${id}" prepare() returned no complete function`,
      )
    }
    // Read once: a later mutation of what `prepare()` returned cannot move this dispatch.
    dispatchers.set(id, { complete: complete.bind(prepared) as PreparedProvider['complete'] })
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
  parts: readonly ContentPart[]
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
  const abortedWithAttempts = (): LLMDispatchError => aborted(operation, copyAttempts(attempts))
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

/** What an attempt learned about billing from the response itself (spec §7). */
interface Billing {
  usage: AttemptRecord['usage']
  /** The provider-reported cost when it is a finite non-negative number; else absent. */
  costUsd: number | undefined
}

/** What reading a `ProviderResponse` produced; only a `complete` body travels onward. */
type ReadResponse =
  | ({
      kind: 'complete'
      text: string
      images: readonly GeneratedImage[] | undefined
    } & Billing)
  | ({ kind: 'truncated' | 'refused' } & Billing)
  | ({ kind: 'malformed' } & Billing)

const IMAGE_MEDIA_TYPE_SET: ReadonlySet<string> = new Set(IMAGE_MEDIA_TYPES)

/**
 * Validates a resolved `ProviderResponse` (spec §3, §6).
 *
 * Termination before content: a `'truncated'`/`'refused'` body never reaches the §3
 * pipeline, but `text: string` belongs to every variant of the union, so a non-string body
 * is still a §6 shape failure. Every property is read once behind a guard, so a hostile
 * response classifies `malformed_response` instead of throwing into the state machine.
 * `images` is read in image format only (§3 point 4b); `costUsd` on every kind (§7).
 */
function readResponse(response: unknown, format: OutputFormat): ReadResponse {
  // Billing is read first and kept outside the guard: a property that throws later in the
  // read makes the response malformed but does not un-report a cost already read (§7).
  let usage: AttemptRecord['usage'] = null
  let costUsd: number | undefined
  try {
    if (!isRecord(response)) return { kind: 'malformed', usage, costUsd }
    const kind = response.kind
    usage = normalizeUsage(response.usage)
    costUsd = reportedCost(response.costUsd)
    if (kind !== 'complete' && kind !== 'truncated' && kind !== 'refused') {
      return { kind: 'malformed', usage, costUsd }
    }
    const text = response.text
    if (typeof text !== 'string') return { kind: 'malformed', usage, costUsd }
    if (kind !== 'complete') return { kind, usage, costUsd }
    if (format !== 'image') return { kind, text, images: undefined, usage, costUsd }
    const images = readImages(response.images)
    if (images === null) return { kind: 'malformed', usage, costUsd }
    return { kind, text, images, usage, costUsd }
  } catch {
    return { kind: 'malformed', usage, costUsd }
  }
}

/** §7: a reported cost counts only as a finite non-negative number; anything else is absent. */
function reportedCost(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value === 0 ? 0 : value
}

/** §3 point 4b: how many images one response may carry, whatever the operation asked for. */
const MAX_RESPONSE_IMAGES = 10

/** §3 point 4b: the per-image response ceiling, in base64 characters (22.5 MB decoded). */
const MAX_RESPONSE_IMAGE_CHARACTERS = 30_000_000

/**
 * Normalizes a complete response's `images` into owned, frozen `GeneratedImage`s (§3 point
 * 4b), or `null` for any shape failure. Absent counts as none. Each element is read once;
 * dimensions the adapter stated are checked against the header, absent ones read from it.
 *
 * The two response-side caps come first: the count before any element is read, and each
 * element's data length before that element's grammar and header work, so an oversized
 * payload costs one length read rather than a scan and a decode.
 */
function readImages(value: unknown): readonly GeneratedImage[] | null {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) return null
  // Length once, then indexed reads: an overridden iterator cannot yield a sequence other
  // than the one validated, and nothing is copied before element 0 has been checked.
  const length: unknown = (value as unknown[]).length
  if (!isCount(length) || length > MAX_RESPONSE_IMAGES) return null
  const images: GeneratedImage[] = []
  for (let index = 0; index < length; index++) {
    const element: unknown = (value as unknown[])[index]
    if (!isRecord(element)) return null
    const { mediaType, data, width, height } = element
    if (typeof data === 'string' && data.length > MAX_RESPONSE_IMAGE_CHARACTERS) return null
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPE_SET.has(mediaType)) return null
    if (base64Problem(data) !== null) return null
    const type = mediaType as GeneratedImage['mediaType']
    const header = readImageDimensions(type, data as string)
    if (header === null) return null
    if (width !== undefined || height !== undefined) {
      if (!isCount(width) || !isCount(height)) return null
      if (width !== header.width || height !== header.height) return null
    }
    images.push(
      Object.freeze({
        type: 'file',
        mediaType: type,
        data: data as string,
        width: header.width,
        height: header.height,
      }),
    )
  }
  return Object.freeze(images)
}

/** The §3 `responseFormat` for an operation, from the `createSwitch` snapshot. */
function responseFormatOf(op: ValidatedOperation): ProviderRequest['responseFormat'] {
  if (op.format === 'image') return { type: 'image', ...op.image }
  if (op.format === 'text') return { type: 'text' }
  if (op.format === 'json-any') return { type: 'json', topLevel: 'any' }
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

  const NO_BILLING: Billing = { usage: null, costUsd: undefined }

  function record(outcome: AttemptRecord['outcome'], billing: Billing, status?: number): void {
    // §7: a well-formed reported cost is authoritative; otherwise the pricing table.
    const attempt: AttemptRecord = {
      provider: target.provider,
      model: target.model,
      outcome,
      usage: billing.usage,
      costUsd:
        billing.costUsd ??
        priceAttempt(ctx.pricing, target.provider, target.model, billing.usage, op.format),
      durationMs,
    }
    if (status !== undefined) attempt.status = status
    attempts.push(attempt)
  }

  function recordAndFail(
    kind: Exclude<AttemptFailureKind, 'output_schema_error' | 'quality_error'>,
    status: number | undefined,
    billing: Billing = NO_BILLING,
  ): AttemptEnd {
    record(kind, billing, status)
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
    parts: shared.parts,
    model: target.model,
    responseFormat: responseFormatOf(op),
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

  const read = readResponse(raced.response, op.format)
  if (read.kind !== 'complete') {
    if (read.kind === 'malformed') return recordAndFail('malformed_response', undefined, read)
    return recordAndFail(read.kind, undefined, read)
  }

  const output = await processOutput(
    { text: read.text, images: read.images },
    op.format,
    op.definition,
    shared.parsedInput,
    signal,
  )
  switch (output.type) {
    case 'success':
      record('succeeded', read)
      return { type: 'success', data: output.data }
    case 'rejected':
      return recordAndFail('output_rejected', undefined, read)
    case 'aborted':
      return recordAndFail('aborted', undefined, read)
    case 'user-error':
      record(output.outcome, read)
      return { type: 'user-error', error: output.error }
  }
}
