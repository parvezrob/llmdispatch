/**
 * The projection every store applies before it writes attempt records.
 *
 * Spec §4 draws the privacy boundary at seven fields; copying exactly those means an object
 * that also carries a prompt or a raw error cannot reach a ledger, whatever the caller hands
 * over.
 *
 * @module
 */

import type { AttemptRecord } from '../../types'
import { assertStoreString } from './domain'

/**
 * Copies each record onto the fields a store may persist.
 *
 * @param attempts The records as the caller supplied them.
 * @throws `StoreDomainError` when a record's `provider` or `model` is outside the string domain.
 */
export function projectAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  return attempts.map((attempt, index) => {
    // Every field read exactly once, then the projection is what gets checked: a getter that
    // answers differently the second time cannot pass the check with one value and be written
    // with another.
    const { provider, model, outcome, usage, costUsd, durationMs, status } = attempt
    const record: AttemptRecord = {
      provider,
      model,
      outcome,
      usage:
        usage === null
          ? null
          : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      costUsd,
      durationMs,
    }
    if (status !== undefined) record.status = status
    assertStoreString(record.provider, `attempts[${String(index)}].provider`)
    assertStoreString(record.model, `attempts[${String(index)}].model`)
    return record
  })
}
