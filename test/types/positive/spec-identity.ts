// @targets spec, package
//
// Declaration identity: every name the package publishes resolves to exactly the type the
// specification declares, not merely to one assignable to it. The comparison runs through a
// conditional type, which is the strictest one TypeScript exposes; generics are
// compared instantiated, since an uninstantiated one cannot be written as a type argument.
// Classes are compared through a homomorphic mapped type over their members, because two
// class declarations with a private member are never the same type however identical their
// members are.
import type { z } from 'zod'

import type * as Conformance from 'llmdispatch/conformance'
import type * as Postgres from 'llmdispatch/postgres'
import type * as Package from 'llmdispatch'

import type * as SpecConformance from '../spec-surface-conformance'
import type * as SpecPostgres from '../spec-surface-postgres'
import type * as Spec from '../spec-surface'

// Two types are identical when the compiler resolves these two conditional types to the same
// one, which it does only for types it considers the same declaration — not merely assignable.
type Identical<Left, Right> =
  (<T>(value: T) => T extends Left ? 1 : 2) extends <T>(value: T) => T extends Right ? 1 : 2
    ? true
    : false

/** Fails to compile when what it is handed is not `true`. */
type Holds<Claim extends true> = Claim

/** Instance members only: a private constructor makes two class declarations distinct types. */
type Members<T> = { [Key in keyof T]: T[Key] }

export type SectionSix = [
  Holds<Identical<Package.OperationsMap, Spec.OperationsMap>>,
  Holds<Identical<Package.Switch<Package.OperationsMap>, Spec.Switch<Spec.OperationsMap>>>,
  Holds<
    Identical<
      Package.CreateSwitchConfig<Package.OperationsMap>,
      Spec.CreateSwitchConfig<Spec.OperationsMap>
    >
  >,
  Holds<Identical<Package.SettlementFailure, Spec.SettlementFailure>>,
  Holds<Identical<Package.StorePair, Spec.StorePair>>,
  Holds<Identical<Package.Logger, Spec.Logger>>,
  Holds<
    Identical<
      Package.OperationDefinition<z.ZodString, z.ZodNumber>,
      Spec.OperationDefinition<z.ZodString, z.ZodNumber>
    >
  >,
  Holds<Identical<Package.QualityVerdict, Spec.QualityVerdict>>,
  Holds<Identical<Package.OperationRoute, Spec.OperationRoute>>,
  Holds<Identical<Package.RouteTarget, Spec.RouteTarget>>,
  Holds<Identical<Package.OperationConfigView, Spec.OperationConfigView>>,
  Holds<Identical<Package.QuotaView, Spec.QuotaView>>,
  Holds<Identical<Package.RunResult<{ summary: string }>, Spec.RunResult<{ summary: string }>>>,
  Holds<Identical<Package.AttemptOutcome, Spec.AttemptOutcome>>,
  Holds<Identical<Package.AttemptRecord, Spec.AttemptRecord>>,
  Holds<Identical<Package.TokenUsage, Spec.TokenUsage>>,
  Holds<Identical<Package.ModelPrice, Spec.ModelPrice>>,
  Holds<Identical<Package.Provider, Spec.Provider>>,
  Holds<Identical<Package.PreparedProvider, Spec.PreparedProvider>>,
  Holds<Identical<Package.ProviderRequest, Spec.ProviderRequest>>,
  Holds<Identical<Package.ProviderResponse, Spec.ProviderResponse>>,
  Holds<Identical<Package.ProviderErrorKind, Spec.ProviderErrorKind>>,
  Holds<Identical<Package.ApiKeyResolver, Spec.ApiKeyResolver>>,
  Holds<Identical<Package.ConfigStore, Spec.ConfigStore>>,
  Holds<Identical<Package.QuotaKey, Spec.QuotaKey>>,
  Holds<Identical<Package.ReservationEnvelope, Spec.ReservationEnvelope>>,
  Holds<Identical<Package.UsageStore, Spec.UsageStore>>,
]

export type SectionSixValues = [
  Holds<Identical<Members<Package.LLMDispatchError>, Members<Spec.LLMDispatchError>>>,
  Holds<Identical<Members<Package.ProviderError>, Members<Spec.ProviderError>>>,
  Holds<Identical<Members<typeof Package.ProviderError>, Members<typeof Spec.ProviderError>>>,
  Holds<
    Identical<
      ConstructorParameters<typeof Package.ProviderError>,
      ConstructorParameters<typeof Spec.ProviderError>
    >
  >,
  Holds<Identical<typeof Package.memoryStores, typeof Spec.memoryStores>>,
  Holds<Identical<typeof Package.postgresStores, typeof Spec.postgresStores>>,
  Holds<Identical<typeof Package.createSwitch, typeof Spec.createSwitch>>,
  Holds<Identical<typeof Package.defineOperation, typeof Spec.defineOperation>>,
  Holds<Identical<typeof Package.defineOperations, typeof Spec.defineOperations>>,
  Holds<Identical<typeof Package.anthropic, typeof Spec.anthropic>>,
  Holds<Identical<typeof Package.openaiCompatible, typeof Spec.openaiCompatible>>,
  Holds<Identical<typeof Package.gemini, typeof Spec.gemini>>,
]

export type SectionSixB = [
  Holds<Identical<Conformance.ConformanceResult, SpecConformance.ConformanceResult>>,
  Holds<
    Identical<
      typeof Conformance.runUsageStoreConformance,
      typeof SpecConformance.runUsageStoreConformance
    >
  >,
  Holds<
    Identical<
      typeof Conformance.runConfigStoreConformance,
      typeof SpecConformance.runConfigStoreConformance
    >
  >,
  Holds<
    Identical<
      typeof Conformance.runProviderConformance,
      typeof SpecConformance.runProviderConformance
    >
  >,
]

export type SectionSixBPostgres = [
  Holds<Identical<typeof Postgres.MIGRATIONS, typeof SpecPostgres.MIGRATIONS>>,
  Holds<Identical<typeof Postgres.migrationSql, typeof SpecPostgres.migrationSql>>,
]
