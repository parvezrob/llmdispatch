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
    assertStoreString(attempt.provider, `attempts[${String(index)}].provider`)
    assertStoreString(attempt.model, `attempts[${String(index)}].model`)
    const record: AttemptRecord = {
      provider: attempt.provider,
      model: attempt.model,
      outcome: attempt.outcome,
      usage:
        attempt.usage === null
          ? null
          : {
              inputTokens: attempt.usage.inputTokens,
              outputTokens: attempt.usage.outputTokens,
            },
      costUsd: attempt.costUsd,
      durationMs: attempt.durationMs,
    }
    if (attempt.status !== undefined) record.status = attempt.status
    return record
  })
}
