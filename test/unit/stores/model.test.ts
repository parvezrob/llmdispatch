import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createMemoryStores } from '../../../src/stores/memory'
import { LEASE_MS, observe, referenceSystem, storeScript } from '../../helpers/store-model'
import type { QuotaSystem } from '../../helpers/store-model'

/** The memory pair, wrapped as something a generated script can be run against. */
function memorySystem(): QuotaSystem {
  const memory = createMemoryStores({ leaseMs: LEASE_MS })
  return {
    store: memory.stores.usage,
    setTime: memory.controls.setTime,
    readSettled: async (reservationId) => await memory.controls.readSettled(reservationId),
  }
}

describe('the memory store against the reference model', () => {
  it('answers exactly what the model answers, command for command', async () => {
    await fc.assert(
      fc.asyncProperty(storeScript, async (script) => {
        expect(await observe(memorySystem(), script)).toEqual(
          await observe(referenceSystem(), script),
        )
      }),
      { numRuns: 300 },
    )
  })
})
