import { describe, expect, it } from 'vitest'

import * as conformance from '../../src/conformance'
import * as index from '../../src/index'
import * as postgres from '../../src/postgres'

describe('entry points', () => {
  it('loads every entry module the manifest advertises', () => {
    expect(Object.keys(index)).toEqual([])
    expect(Object.keys(postgres)).toEqual([])
    expect(Object.keys(conformance)).toEqual([])
  })
})
