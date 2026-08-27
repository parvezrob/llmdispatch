/**
 * The error layer: the two classes adopters see, and the factories the package throws through.
 *
 * Only the classes reach the published surface. Letting an adopter build an `LLMDispatchError`
 * would make its code mean "someone said so" rather than "the package classified it".
 *
 * @module
 */

export { LLMDispatchError } from './llmdispatch-error'
export { ProviderError } from './provider-error'
export {
  aborted,
  configStoreUnavailable,
  invalidConfigLocal,
  invalidConfigProvider,
  invalidConfigTransientPrepare,
  invalidInput,
  missingSubject,
  outputRejected,
  providerFailed,
  quotaExceeded,
  usageStoreUnavailable,
} from './factories'
