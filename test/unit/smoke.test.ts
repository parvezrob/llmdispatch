import { describe, expect, it } from 'vitest'

import * as conformance from '../../src/conformance'
import * as index from '../../src/index'
import * as postgres from '../../src/postgres'

describe('entry points', () => {
  it('loads every entry module the manifest advertises', () => {
    // Compared sorted: this is the published set of runtime exports, not an artefact of how
    // the entry file happens to be written (or of the test runner's module transform).
    expect(Object.keys(index).sort()).toEqual([
      'LLMSwitchError',
      'ProviderError',
      'createSwitch',
      'defineOperation',
      'defineOperations',
      'memoryStores',
      'postgresStores',
    ])
    expect(Object.keys(postgres).sort()).toEqual(['MIGRATIONS', 'migrationSql'])
    expect(Object.keys(conformance).sort()).toEqual([
      'runConfigStoreConformance',
      'runUsageStoreConformance',
    ])
  })
})
