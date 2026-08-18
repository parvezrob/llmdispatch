import { describe, expect, it } from 'vitest'

import * as conformance from '../../src/conformance'
import * as index from '../../src/index'
import * as postgres from '../../src/postgres'

describe('entry points', () => {
  it('loads every entry module the manifest advertises', () => {
    // A module namespace lists its names in sorted order, so this is the published set of
    // runtime exports and not an artefact of how the entry file happens to be written.
    expect(Object.keys(index)).toEqual(['LLMSwitchError', 'ProviderError'])
    expect(Object.keys(postgres)).toEqual([])
    expect(Object.keys(conformance)).toEqual([])
  })
})
