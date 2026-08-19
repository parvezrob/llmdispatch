import { describe, expect, it } from 'vitest'

import { createMemoryStores, memoryStores } from '../../../src/stores/memory'
import { StoreDomainError } from '../../../src/stores/shared/domain'
import type { AttemptRecord, ReservationEnvelope, UsageStore } from '../../../src/types'

const START = '2026-01-15T12:00:00.000Z'
const RESETS_AT = '2026-01-16T00:00:00.000Z'
const DAY = '2026-01-15'
const LEASE_MS = 60_000

const KEY = { operation: 'summarize', subjectId: 'user-1' }

const RECORD: AttemptRecord = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  outcome: 'succeeded',
  status: 200,
  usage: { inputTokens: 120, outputTokens: 34 },
  costUsd: 0.00042,
  durationMs: 250,
}

/** A store pair with its clock pinned to a fixed instant. */
async function fixture(leaseMs = LEASE_MS) {
  const memory = createMemoryStores({ leaseMs })
  await memory.controls.setTime(new Date(START))
  return memory
}

type ReserveResult = Awaited<ReturnType<UsageStore['reserve']>>

function admitted(result: ReserveResult): ReservationEnvelope {
  if (!result.ok) throw new Error(`the reserve was denied with used ${String(result.used)}`)
  return result.reservation
}

function denied(result: ReserveResult): { used: number; resetsAt: string } {
  if (result.ok) throw new Error('the reserve was admitted')
  return result
}

/** The lease of an admitted reserve. */
function leaseOf(result: ReserveResult): string {
  if (!result.ok) throw new Error('the reserve was denied')
  return result.expiresAt
}

describe('reserve admits exactly the limit', () => {
  it('admits the limit when every caller reserves in the same tick', async () => {
    const { stores, controls } = await fixture()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stores.usage.reserve(KEY, 3)),
    )

    expect(results.filter((result) => result.ok)).toHaveLength(3)
    for (const result of results) {
      if (result.ok) continue
      expect(result.used).toBe(3)
      expect(result.resetsAt).toBe(RESETS_AT)
    }
    expect(await controls.inspect(KEY, DAY)).toEqual({
      reservations: 3,
      counter: { used: 3, lastAdmitted: false },
    })
  })

  it('admits the limit when the callers arrive one after another', async () => {
    const { stores } = await fixture()
    const outcomes: boolean[] = []
    for (let caller = 0; caller < 5; caller += 1) {
      outcomes.push((await stores.usage.reserve(KEY, 3)).ok)
    }

    expect(outcomes).toEqual([true, true, true, false, false])
  })

  it('issues a distinct reservation id every time', async () => {
    const { stores, controls } = await fixture()
    const ids = [admitted(await stores.usage.reserve(KEY, 2)).reservationId]
    ids.push(admitted(await stores.usage.reserve(KEY, 2)).reservationId)
    await controls.setTime(new Date('2026-01-16T12:00:00.000Z'))
    ids.push(admitted(await stores.usage.reserve(KEY, 2)).reservationId)

    expect(new Set(ids).size).toBe(3)
  })
})

describe('the envelope a reserve returns', () => {
  it('carries the requested key, the store day and ISO timestamps', async () => {
    const { stores } = await fixture()
    const result = await stores.usage.reserve(KEY, 1)
    const envelope = admitted(result)

    expect(envelope.key).toEqual(KEY)
    expect(envelope.key).not.toBe(KEY)
    expect(envelope.day).toBe(DAY)
    expect(leaseOf(result)).toBe('2026-01-15T12:01:00.000Z')
    expect((await stores.usage.snapshot(KEY)).resetsAt).toBe(RESETS_AT)
  })

  it('never leases past the end of the store day', async () => {
    const { stores, controls } = await fixture(600_000)
    await controls.setTime(new Date('2026-01-15T23:59:00.000Z'))

    expect(leaseOf(await stores.usage.reserve(KEY, 1))).toBe(RESETS_AT)
  })
})

describe('commit', () => {
  it('answers committed however often it is retried', async () => {
    const { stores } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))

    expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
    expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
    expect(
      await Promise.all([
        stores.usage.commit(envelope.reservationId),
        stores.usage.commit(envelope.reservationId),
      ]),
    ).toEqual(['committed', 'committed'])
  })

  it('answers missing for an id it never issued', async () => {
    const { stores } = await fixture()

    expect(await stores.usage.commit('5b1f5b7c-2b1e-4a4e-9c2a-000000000000')).toBe('missing')
  })

  it('answers missing for an id no store could hold', async () => {
    const { stores } = await fixture()

    expect(await stores.usage.commit('id-with-a-\u0000-in-it')).toBe('missing')
  })

  it('keeps the slot when it commits before a later reserve reclaims', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await stores.usage.commit(envelope.reservationId)
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))

    expect(denied(await stores.usage.reserve(KEY, 1)).used).toBe(1)
    expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
  })

  it('answers expired once a reserve has reclaimed the lapsed slot', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))
    admitted(await stores.usage.reserve(KEY, 1))

    expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
  })

  it('makes expired final, so a retry can never commit the slot afterwards', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))

    expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
    expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
    // The row is still counted until a reserve reclaims it, and reclaiming frees it.
    expect((await controls.inspect(KEY, DAY)).counter).toEqual({ used: 1, lastAdmitted: true })
    admitted(await stores.usage.reserve(KEY, 1))
    expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
  })
})

describe('leases and the day boundary', () => {
  it('frees a lapsed pending slot and never a committed one', async () => {
    const { stores, controls } = await fixture()
    const pending = admitted(await stores.usage.reserve(KEY, 2))
    const committed = admitted(await stores.usage.reserve(KEY, 2))
    await stores.usage.commit(committed.reservationId)
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))

    expect((await stores.usage.snapshot(KEY)).used).toBe(1)
    expect(denied(await stores.usage.reserve(KEY, 1)).used).toBe(1)
    expect(await stores.usage.commit(pending.reservationId)).toBe('expired')
    // Still 1 at the far end of the day: a committed slot is never refunded.
    await controls.setTime(new Date('2026-01-15T23:00:00.000Z'))
    expect((await stores.usage.snapshot(KEY)).used).toBe(1)
  })

  it('starts the next day at zero and leaves the old day alone', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await stores.usage.commit(envelope.reservationId)
    await controls.setTime(new Date('2026-01-16T00:00:00.000Z'))

    const snapshot = await stores.usage.snapshot(KEY)
    expect(snapshot).toEqual({ used: 0, resetsAt: '2026-01-17T00:00:00.000Z' })
    expect(admitted(await stores.usage.reserve(KEY, 1)).day).toBe('2026-01-16')
    expect((await controls.inspect(KEY, DAY)).counter).toEqual({ used: 1, lastAdmitted: true })
  })
})

describe('a denied reserve', () => {
  it('writes the counter row and no reservation row at limit zero', async () => {
    const { stores, controls } = await fixture()

    expect(denied(await stores.usage.reserve(KEY, 0))).toMatchObject({
      used: 0,
      resetsAt: RESETS_AT,
    })
    expect(await controls.inspect(KEY, DAY)).toEqual({
      reservations: 0,
      counter: { used: 0, lastAdmitted: false },
    })
    expect((await stores.usage.snapshot(KEY)).used).toBe(0)
  })

  it('still persists the slots it reclaimed on the way to denying', async () => {
    const { stores, controls } = await fixture()
    admitted(await stores.usage.reserve(KEY, 1))
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))

    expect(denied(await stores.usage.reserve(KEY, 0)).used).toBe(0)
    admitted(await stores.usage.reserve(KEY, 1))
    expect((await stores.usage.snapshot(KEY)).used).toBe(1)
  })

  it('reports the day count when the limit is lowered below it', async () => {
    const { stores } = await fixture()
    const pending = admitted(await stores.usage.reserve(KEY, 2))
    const committed = admitted(await stores.usage.reserve(KEY, 2))
    await stores.usage.commit(committed.reservationId)

    expect(denied(await stores.usage.reserve(KEY, 1)).used).toBe(2)
    expect(await stores.usage.commit(pending.reservationId)).toBe('committed')
    expect((await stores.usage.snapshot(KEY)).used).toBe(2)
  })

  it('counts only what is still live after a lapse', async () => {
    const { stores, controls } = await fixture()
    admitted(await stores.usage.reserve(KEY, 3))
    admitted(await stores.usage.reserve(KEY, 3))
    const committed = admitted(await stores.usage.reserve(KEY, 3))
    await stores.usage.commit(committed.reservationId)
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))

    expect(denied(await stores.usage.reserve(KEY, 1)).used).toBe(1)
    admitted(await stores.usage.reserve(KEY, 2))
  })
})

describe('settle', () => {
  it('records a pending, an expired and an unknown reservation without moving accounting', async () => {
    const { stores, controls } = await fixture()
    const pending = admitted(await stores.usage.reserve(KEY, 2))
    const unknown: ReservationEnvelope = {
      reservationId: '5b1f5b7c-2b1e-4a4e-9c2a-000000000000',
      key: KEY,
      day: DAY,
    }
    await stores.usage.settle(pending, 'succeeded', [RECORD])
    await stores.usage.settle(unknown, 'failed', [RECORD])

    expect((await controls.readSettled(pending.reservationId))?.outcome).toBe('succeeded')
    expect(await controls.readSettled(unknown.reservationId)).toEqual({
      reservation: unknown,
      outcome: 'failed',
      attempts: [RECORD],
    })
    expect((await stores.usage.snapshot(KEY)).used).toBe(1)

    const expired = admitted(await stores.usage.reserve(KEY, 2))
    await controls.setTime(new Date('2026-01-15T12:02:00.000Z'))
    await stores.usage.settle(expired, 'failed', [RECORD])
    expect((await controls.readSettled(expired.reservationId))?.outcome).toBe('failed')
    expect((await stores.usage.snapshot(KEY)).used).toBe(0)
  })

  it('keeps the first payload and ignores a later one', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await stores.usage.settle(envelope, 'succeeded', [RECORD])
    await stores.usage.settle(envelope, 'failed', [{ ...RECORD, outcome: 'timeout' }])

    expect(await controls.readSettled(envelope.reservationId)).toEqual({
      reservation: envelope,
      outcome: 'succeeded',
      attempts: [RECORD],
    })
  })

  it('round-trips every field of a record, with and without usage', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    const attempts: AttemptRecord[] = [
      RECORD,
      {
        provider: 'openai',
        model: 'gpt-5',
        outcome: 'timeout',
        usage: null,
        costUsd: null,
        durationMs: 60_000,
      },
    ]
    await stores.usage.settle(envelope, 'failed', attempts)

    expect((await controls.readSettled(envelope.reservationId))?.attempts).toEqual(attempts)
  })

  it('persists nothing but the seven fields a record is allowed to carry', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    const carrying = {
      ...RECORD,
      prompt: 'summarise the following confidential text',
      rawError: { stack: 'at somewhere' },
    } as AttemptRecord
    await stores.usage.settle(envelope, 'succeeded', [carrying])

    const settled = await controls.readSettled(envelope.reservationId)
    expect(settled?.attempts).toEqual([RECORD])
    expect(JSON.stringify(settled)).not.toContain('confidential')
    expect(JSON.stringify(settled)).not.toContain('rawError')
  })

  it('is detached from the array a caller keeps and from what a reader is handed', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    const attempts = [{ ...RECORD }]
    await stores.usage.settle(envelope, 'succeeded', attempts)

    attempts[0]!.model = 'edited-after-settle'
    attempts.push({ ...RECORD })
    const first = await controls.readSettled(envelope.reservationId)
    first!.attempts[0]!.provider = 'edited-after-read'

    expect((await controls.readSettled(envelope.reservationId))?.attempts).toEqual([RECORD])
  })
})

describe('the string domain both stores share', () => {
  const nul = 'a\u0000b'
  const loneSurrogate = 'a\uD800b'
  const atTheLimit = '€'.repeat(333) + 'a'
  const overTheLimit = '€'.repeat(333) + 'ab'

  it('accepts a key of exactly a thousand bytes and refuses one byte more', async () => {
    const { stores } = await fixture()

    expect(
      admitted(await stores.usage.reserve({ ...KEY, subjectId: atTheLimit }, 1)),
    ).toBeDefined()
    await expect(
      stores.usage.reserve({ ...KEY, subjectId: overTheLimit }, 1),
    ).rejects.toBeInstanceOf(StoreDomainError)
  })

  it('refuses every string a relational store could not hold', async () => {
    const { stores } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))

    for (const bad of [nul, loneSurrogate, overTheLimit]) {
      await expect(stores.usage.reserve({ ...KEY, operation: bad }, 1)).rejects.toBeInstanceOf(
        StoreDomainError,
      )
      await expect(stores.usage.snapshot({ ...KEY, subjectId: bad })).rejects.toBeInstanceOf(
        StoreDomainError,
      )
      await expect(
        stores.usage.settle({ ...envelope, reservationId: bad }, 'succeeded', [RECORD]),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.usage.settle(envelope, 'succeeded', [{ ...RECORD, model: bad }]),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.config.set(bad, { provider: 'p', model: 'm' }),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.config.set('summarize', { provider: bad, model: 'm' }),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.config.set('summarize', {
          provider: 'p',
          model: 'm',
          fallback: { provider: 'p', model: bad },
        }),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.config.set('summarize', {
          provider: 'p',
          model: 'm',
          fallback: { provider: bad, model: 'm' },
        }),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(stores.config.delete(bad)).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.usage.settle({ ...envelope, day: bad }, 'succeeded', [RECORD]),
      ).rejects.toBeInstanceOf(StoreDomainError)
    }
  })

  it('writes nothing when it refuses a settle', async () => {
    const { stores, controls } = await fixture()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))
    await expect(
      stores.usage.settle(envelope, 'succeeded', [{ ...RECORD, provider: nul }]),
    ).rejects.toBeInstanceOf(StoreDomainError)

    expect(await controls.readSettled(envelope.reservationId)).toBeNull()
  })
})

describe('the factories', () => {
  it('takes no options at all on the published one', () => {
    const stores = memoryStores()

    expect(memoryStores).toHaveLength(0)
    expect(Object.keys(stores).sort()).toEqual(['config', 'usage'])
  })

  it('gives each pair its own state', async () => {
    const first = memoryStores()
    const second = memoryStores()
    admitted(await first.usage.reserve(KEY, 1))

    expect((await second.usage.snapshot(KEY)).used).toBe(0)
  })

  it('captures its arguments before the caller can edit them', async () => {
    const { stores } = await fixture()
    const key = { operation: 'summarize', subjectId: 'user-1' }
    const reserving = stores.usage.reserve(key, 1)
    key.subjectId = 'edited-before-the-await'

    expect(admitted(await reserving).key).toEqual({
      operation: 'summarize',
      subjectId: 'user-1',
    })

    const route = { provider: 'claude', model: 'claude-sonnet-4-6' }
    const setting = stores.config.set('summarize', route)
    route.model = 'edited-before-the-await'
    await setting

    expect(await stores.config.getAll()).toEqual({
      summarize: { provider: 'claude', model: 'claude-sonnet-4-6' },
    })
  })

  it('refuses a lease the PostgreSQL store could not accept either', () => {
    for (const leaseMs of [4_999, 600_001, 5_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createMemoryStores({ leaseMs })).toThrow(/leaseMs/)
    }
    expect(() => createMemoryStores({ leaseMs: 5_000 })).not.toThrow()
    expect(() => createMemoryStores({ leaseMs: 600_000 })).not.toThrow()
  })

  it('refuses a clock that moves backwards before a reset', async () => {
    const { controls } = await fixture()

    await expect(controls.setTime(new Date('2026-01-15T11:59:59.999Z'))).rejects.toThrow(
      /backwards/,
    )
    await controls.reset()
    await expect(
      controls.setTime(new Date('2026-01-15T11:59:59.999Z')),
    ).resolves.toBeUndefined()
  })

  it('reads the wall clock until a control pins it', async () => {
    const stores = memoryStores()
    const before = Date.now()
    const envelope = admitted(await stores.usage.reserve(KEY, 1))

    expect(envelope.day).toBe(new Date(before).toISOString().slice(0, 10))
  })
})
