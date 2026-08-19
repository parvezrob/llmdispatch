import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresStores } from '../../../src/stores/postgres'
import { StoreDomainError } from '../../../src/stores/shared/domain'
import type { AttemptRecord, ReservationEnvelope } from '../../../src/types'
import {
  DAY,
  KEY,
  LEASE_MS,
  RECORD,
  RESETS_AT,
  START,
  UNSTORABLE,
  WAIT_MS,
  admitted,
  at,
  denied,
  leaseOf,
  pause,
  usageHelpers,
  watch,
} from './helpers'
import type { ReserveRow } from './helpers'
import {
  createPool,
  describeDatabase,
  dropSchema,
  migrate,
  sqlStateOf,
  uniqueSchema,
} from './setup'

const SCHEMA = uniqueSchema('usage')

let pool: pg.Pool

const { QUOTED, STATEMENTS, fixture, onRealTime, reservationStates, heldTransaction } =
  usageHelpers(() => pool, SCHEMA)

describeDatabase('the PostgreSQL usage store', () => {
  beforeAll(async () => {
    pool = createPool({ max: 20 })
    await migrate(pool, SCHEMA)
  })

  afterAll(async () => {
    await dropSchema(pool, SCHEMA)
    await pool.end()
  })

  describe('reserve admits exactly the limit', () => {
    it('admits the limit when twelve callers arrive at once', async () => {
      const { stores } = await fixture()

      const results = await Promise.all(
        Array.from({ length: 12 }, () => stores.usage.reserve(KEY, 5)),
      )

      const envelopes = results.flatMap((result) => (result.ok ? [result.reservation] : []))
      expect(envelopes).toHaveLength(5)
      expect(new Set(envelopes.map((envelope) => envelope.reservationId)).size).toBe(5)
      for (const result of results) {
        if (result.ok) continue
        expect(result.used).toBe(5)
        expect(Number.isSafeInteger(result.used)).toBe(true)
        expect(result.resetsAt).toBe(RESETS_AT)
      }
    })

    it('admits one of two callers racing to create the counter row', async () => {
      const { stores, controls } = await fixture()

      for (let round = 0; round < 25; round += 1) {
        const key = { operation: 'summarize', subjectId: `fresh-${String(round)}` }
        const results = await Promise.all([
          stores.usage.reserve(key, 1),
          stores.usage.reserve(key, 1),
        ])

        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(denied(results.find((result) => !result.ok) ?? results[0]).used).toBe(1)
        expect(await controls.inspect(key, DAY)).toEqual({
          reservations: 1,
          counter: { used: 1, lastAdmitted: false },
        })
      }
    })

    it('never lets live usage pass the limit under a randomized mix', async () => {
      const { stores, controls } = await fixture(5_000)
      const limit = 3

      for (let wave = 0; wave < 6; wave += 1) {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => stores.usage.reserve(KEY, limit)),
        )
        const envelopes = results.flatMap((result) => (result.ok ? [result.reservation] : []))
        await Promise.all(
          envelopes
            .filter((_, index) => index % 2 === 0)
            .map((envelope) => stores.usage.commit(envelope.reservationId)),
        )

        const snapshot = await stores.usage.snapshot(KEY)
        expect(snapshot.used).toBeLessThanOrEqual(limit)
        // Invariant I1: the counter is exactly the rows that are not expired.
        const inspection = await controls.inspect(KEY, DAY)
        const states = await reservationStates()
        expect(inspection.counter?.used).toBe(
          states.filter((state) => state !== 'expired').length,
        )
      }
    })

    it('gives two callers reclaiming one lapsed slot a linearizable pair of answers', async () => {
      for (let round = 0; round < 20; round += 1) {
        const { stores, controls } = await fixture(5_000)
        admitted(await stores.usage.reserve(KEY, 1))
        await controls.setTime(at(6_000))

        // One caller may admit nothing at all and the other exactly one slot; whoever reaches
        // the counter first reclaims the lapsed row, and the other sees the result of that.
        const [zero, one] = await Promise.all([
          stores.usage.reserve(KEY, 0),
          stores.usage.reserve(KEY, 1),
        ])

        expect([0, 1]).toContain(denied(zero).used)
        admitted(one)
        const inspection = await controls.inspect(KEY, DAY)
        expect(inspection.reservations).toBe(2)
        expect(inspection.counter?.used).toBe(1)
      }
    })
  })

  describe('commit', () => {
    it('answers committed however often it is retried', async () => {
      const { stores } = await fixture()
      const envelope = admitted(await stores.usage.reserve(KEY, 1))

      const answers = await Promise.all(
        Array.from({ length: 20 }, () => stores.usage.commit(envelope.reservationId)),
      )

      expect(new Set(answers)).toEqual(new Set(['committed']))
      expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
    })

    it('answers missing for an id it never issued', async () => {
      const { stores } = await fixture()

      expect(await stores.usage.commit('00000000-0000-4000-8000-000000000000')).toBe('missing')
    })

    it('answers expired once the lease has run out, and keeps answering it', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      await controls.setTime(at(6_000))

      expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
      expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
      expect(await reservationStates()).toEqual(['pending'])
    })

    it('keeps a slot a commit took before a later reserve could reclaim it', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))

      expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
      await controls.setTime(at(6_000))
      denied(await stores.usage.reserve(KEY, 1))

      expect(await stores.usage.commit(envelope.reservationId)).toBe('committed')
      expect(await reservationStates()).toEqual(['committed'])
    })

    it('answers expired for a slot a later reserve reclaimed first', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      await controls.setTime(at(6_000))
      admitted(await stores.usage.reserve(KEY, 1))

      expect(await stores.usage.commit(envelope.reservationId)).toBe('expired')
      expect(await reservationStates()).toEqual(['expired', 'pending'])
    })
  })

  describe('the lease', () => {
    it('frees a pending slot when it runs out and never a committed one', async () => {
      const { stores, controls } = await fixture(5_000)
      const pending = admitted(await stores.usage.reserve(KEY, 2))
      const committed = admitted(await stores.usage.reserve(KEY, 2))
      expect(await stores.usage.commit(committed.reservationId)).toBe('committed')

      await controls.setTime(at(6_000))

      expect((await stores.usage.snapshot(KEY)).used).toBe(1)
      admitted(await stores.usage.reserve(KEY, 2))
      denied(await stores.usage.reserve(KEY, 2))
      expect(await stores.usage.commit(pending.reservationId)).toBe('expired')

      await controls.setTime(at(30 * 60_000))
      denied(await stores.usage.reserve(KEY, 1))
    })

    it("never runs past the end of the store's day", async () => {
      const { stores, controls } = await fixture(120_000)
      await controls.setTime(new Date('2026-01-15T23:59:00.000Z'))

      const result = await stores.usage.reserve(KEY, 1)

      expect(leaseOf(result)).toBe(RESETS_AT)
      expect(admitted(result).day).toBe(DAY)
    })
  })

  describe("the store's day", () => {
    it('starts the next day at zero and leaves the day before alone', async () => {
      const { stores, controls } = await fixture(600_000)
      await controls.setTime(new Date('2026-01-15T23:58:00.000Z'))
      admitted(await stores.usage.reserve(KEY, 1))
      await controls.setTime(new Date('2026-01-15T23:59:59.000Z'))
      expect((await stores.usage.snapshot(KEY)).used).toBe(1)

      await controls.setTime(new Date('2026-01-16T00:00:01.000Z'))

      expect(await stores.usage.snapshot(KEY)).toEqual({
        used: 0,
        resetsAt: '2026-01-17T00:00:00.000Z',
      })
      expect(admitted(await stores.usage.reserve(KEY, 1)).day).toBe('2026-01-16')
    })

    it('hands back an envelope whose key is the one that was asked for', async () => {
      const { stores } = await fixture()

      const result = await stores.usage.reserve(KEY, 1)

      const envelope = admitted(result)
      expect(envelope.key).toEqual(KEY)
      expect(envelope.day).toBe(DAY)
      expect(envelope.reservationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(leaseOf(result)).toBe(new Date(Date.parse(START) + LEASE_MS).toISOString())
      expect((await stores.usage.snapshot(KEY)).resetsAt).toBe(RESETS_AT)
    })
  })

  describe('settle', () => {
    it('records what happened without moving the accounting', async () => {
      const { stores, controls } = await fixture()
      const envelope = admitted(await stores.usage.reserve(KEY, 2))
      const before = await stores.usage.snapshot(KEY)

      await stores.usage.settle(envelope, 'succeeded', [RECORD])
      await stores.usage.settle(envelope, 'succeeded', [RECORD])
      await stores.usage.settle(envelope, 'failed', [{ ...RECORD, outcome: 'timeout' }])

      const settled = await controls.readSettled(envelope.reservationId)
      expect(settled).toEqual({
        reservation: envelope,
        outcome: 'succeeded',
        attempts: [RECORD],
      })
      expect(await stores.usage.snapshot(KEY)).toEqual(before)
    })

    it('records a reservation it never issued, against the key on the envelope', async () => {
      const { stores, controls } = await fixture()
      const before = await stores.usage.snapshot(KEY)
      const envelope: ReservationEnvelope = {
        reservationId: '11111111-2222-4333-8444-555555555555',
        key: KEY,
        day: DAY,
      }

      await stores.usage.settle(envelope, 'failed', [])

      expect(await controls.readSettled(envelope.reservationId)).toEqual({
        reservation: envelope,
        outcome: 'failed',
        attempts: [],
      })
      expect(await stores.usage.snapshot(KEY)).toEqual(before)
    })

    it('round-trips every field of a record, reported usage or not', async () => {
      const { stores, controls } = await fixture()
      const first = admitted(await stores.usage.reserve(KEY, 2))
      const second = admitted(await stores.usage.reserve(KEY, 2))
      const unreported: AttemptRecord = {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        outcome: 'timeout',
        usage: null,
        costUsd: null,
        durationMs: 60_000,
      }

      await stores.usage.settle(first, 'succeeded', [RECORD, unreported])
      await stores.usage.settle(second, 'failed', [unreported])

      expect((await controls.readSettled(first.reservationId))?.attempts).toEqual([
        RECORD,
        unreported,
      ])
      expect(await controls.readSettled(second.reservationId)).toEqual({
        reservation: second,
        outcome: 'failed',
        attempts: [unreported],
      })
    })

    it('keeps nothing from an attempt but the fields the contract names', async () => {
      const { stores } = await fixture()
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      // A caller can always hand over more than the contract names; nothing but the seven
      // fields may end up in the ledger.
      const noisy = {
        ...RECORD,
        prompt: 'the article a caller must never persist',
        rawError: { body: 'a provider response' },
      }

      await stores.usage.settle(envelope, 'succeeded', [noisy])

      const { rows } = await pool.query<{ attempts: Record<string, unknown>[] }>(
        `SELECT attempts FROM ${QUOTED}.usage_settlements WHERE reservation_id = $1`,
        [envelope.reservationId],
      )
      expect(rows[0]?.attempts.map((attempt) => Object.keys(attempt).sort())).toEqual([
        ['costUsd', 'durationMs', 'model', 'outcome', 'provider', 'status', 'usage'],
      ])
    })
  })

  describe('the limit', () => {
    it('writes the counter row and no reservation when it is zero', async () => {
      const { stores, controls } = await fixture()

      const denial = denied(await stores.usage.reserve(KEY, 0))

      expect(denial).toEqual({ ok: false, used: 0, resetsAt: RESETS_AT })
      expect(await controls.inspect(KEY, DAY)).toEqual({
        reservations: 0,
        counter: { used: 0, lastAdmitted: false },
      })
      const counters = await pool.query(`SELECT * FROM ${QUOTED}.usage_counters`)
      expect(counters.rows).toHaveLength(1)
    })

    it('hands a lapsed slot back even when the reserve that reclaimed it was denied', async () => {
      const { stores, controls } = await fixture(5_000)
      admitted(await stores.usage.reserve(KEY, 1))
      await controls.setTime(at(6_000))

      expect(denied(await stores.usage.reserve(KEY, 0)).used).toBe(0)

      admitted(await stores.usage.reserve(KEY, 1))
      expect(await controls.inspect(KEY, DAY)).toEqual({
        reservations: 2,
        counter: { used: 1, lastAdmitted: true },
      })
    })

    it('denies new reservations when it is lowered below what is already used', async () => {
      const { stores, controls } = await fixture()
      const pending = admitted(await stores.usage.reserve(KEY, 5))
      const committed = admitted(await stores.usage.reserve(KEY, 5))
      expect(await stores.usage.commit(committed.reservationId)).toBe('committed')

      const denial = denied(await stores.usage.reserve(KEY, 1))

      expect(denial.used).toBe(2)
      expect(await stores.usage.commit(pending.reservationId)).toBe('committed')
      expect(await stores.usage.commit(committed.reservationId)).toBe('committed')
      expect(await stores.usage.snapshot(KEY)).toEqual({ used: 2, resetsAt: RESETS_AT })
      expect(await controls.inspect(KEY, DAY)).toEqual({
        reservations: 2,
        counter: { used: 2, lastAdmitted: false },
      })
    })

    it('counts what a lapse left committed and admits again when it is raised', async () => {
      const { stores, controls } = await fixture(5_000)
      admitted(await stores.usage.reserve(KEY, 3))
      admitted(await stores.usage.reserve(KEY, 3))
      const committed = admitted(await stores.usage.reserve(KEY, 3))
      expect(await stores.usage.commit(committed.reservationId)).toBe('committed')
      await controls.setTime(at(6_000))

      expect(denied(await stores.usage.reserve(KEY, 1)).used).toBe(1)

      admitted(await stores.usage.reserve(KEY, 2))
    })
  })

  describe('what reaches the database', () => {
    it('refuses a value no store could hold before it sends anything', async () => {
      const queries: string[] = []
      const counted = {
        query: (sql: string, params?: unknown[]) => {
          queries.push(sql)
          return pool.query(sql, params)
        },
      }
      const { stores } = createPostgresStores({ pool: counted, schema: SCHEMA })
      const envelope: ReservationEnvelope = { reservationId: UNSTORABLE, key: KEY, day: DAY }

      await expect(stores.usage.reserve({ ...KEY, operation: UNSTORABLE }, 1)).rejects.toThrow(
        StoreDomainError,
      )
      await expect(stores.usage.snapshot({ ...KEY, subjectId: 'a\udbff' })).rejects.toThrow(
        StoreDomainError,
      )
      await expect(stores.usage.settle(envelope, 'succeeded', [])).rejects.toThrow(
        StoreDomainError,
      )
      await expect(
        stores.usage.settle({ ...envelope, reservationId: 'ok' }, 'succeeded', [
          { ...RECORD, provider: UNSTORABLE },
        ]),
      ).rejects.toThrow(StoreDomainError)
      expect(await stores.usage.commit(UNSTORABLE)).toBe('missing')
      expect(queries).toEqual([])
    })

    it('lets a driver failure through exactly as it arrived', async () => {
      const failure = new Error('the connection went away')
      const { stores } = createPostgresStores({
        pool: { query: () => Promise.reject(failure) },
        schema: SCHEMA,
      })

      await expect(stores.usage.reserve(KEY, 1)).rejects.toBe(failure)
      await expect(stores.usage.commit('11111111-2222-4333-8444-555555555555')).rejects.toBe(
        failure,
      )
      await expect(stores.usage.snapshot(KEY)).rejects.toBe(failure)
      await expect(
        stores.usage.settle({ reservationId: 'id', key: KEY, day: DAY }, 'failed', []),
      ).rejects.toBe(failure)
      await expect(stores.config.getAll()).rejects.toBe(failure)
      await expect(
        stores.config.set('summarize', { provider: 'claude', model: 'x' }),
      ).rejects.toBe(failure)
      await expect(stores.config.delete('summarize')).rejects.toBe(failure)
    })

    it('holds a subject of exactly a thousand bytes and refuses one byte more', async () => {
      const { stores, controls } = await fixture()
      // Three bytes each, so the boundary falls between two whole characters rather than
      // inside one.
      const thousand = '\u20ac'.repeat(333) + 'a'
      const overLong = `${thousand}a`

      const envelope = admitted(await stores.usage.reserve({ ...KEY, subjectId: thousand }, 1))

      expect(envelope.key.subjectId).toBe(thousand)
      expect(await controls.inspect({ ...KEY, subjectId: thousand }, DAY)).toEqual({
        reservations: 1,
        counter: { used: 1, lastAdmitted: true },
      })
      await expect(
        stores.usage.reserve({ ...KEY, subjectId: overLong }, 1),
      ).rejects.toBeInstanceOf(StoreDomainError)
      await expect(
        stores.usage.settle({ ...envelope, day: DAY }, 'succeeded', [
          { ...RECORD, model: overLong },
        ]),
      ).rejects.toBeInstanceOf(StoreDomainError)
    })

    it('refuses a day that is not a calendar date', async () => {
      const queries: string[] = []
      const counted = {
        query: (sql: string, params?: unknown[]) => {
          queries.push(sql)
          return pool.query(sql, params)
        },
      }
      const { stores, controls } = createPostgresStores({ pool: counted, schema: SCHEMA })
      const envelope: ReservationEnvelope = { reservationId: 'an-id', key: KEY, day: DAY }

      for (const day of [
        '2026-02-30',
        '0000-01-01',
        '2026-1-15',
        '15-01-2026',
        '2026-01-15T00:00:00.000Z',
      ]) {
        await expect(
          stores.usage.settle({ ...envelope, day }, 'succeeded', [RECORD]),
        ).rejects.toBeInstanceOf(StoreDomainError)
      }

      expect(queries).toEqual([])

      // The first year PostgreSQL has: the bound is year zero, which it has no room for at
      // all, not an era of its own.
      await stores.usage.settle({ ...envelope, day: '0001-01-01' }, 'succeeded', [RECORD])
      expect((await controls.readSettled('an-id'))?.reservation.day).toBe('0001-01-01')
    })
  })

  describe('two commits that straddle the end of a lease', () => {
    it('answers committed to the second when the first holds the row and is in time', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      const held = await heldTransaction()
      await held.query(STATEMENTS.commit, [envelope.reservationId, at(1_000).toISOString()])
      await controls.setTime(at(6_000))

      const second = watch(stores.usage.commit(envelope.reservationId))
      await pause(WAIT_MS)
      expect(second.settled()).toBe(false)
      await held.commit()

      expect(await second.promise).toBe('committed')
      expect(await reservationStates()).toEqual(['committed'])
    })

    it('answers expired when a reserve holds the row and has reclaimed it', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      const held = await heldTransaction()
      await held.query(STATEMENTS.reserve, [
        KEY.operation,
        KEY.subjectId,
        1,
        5_000,
        at(6_000).toISOString(),
      ])
      await controls.setTime(at(6_500))

      const commit = watch(stores.usage.commit(envelope.reservationId))
      await pause(WAIT_MS)
      expect(commit.settled()).toBe(false)
      await held.commit()

      expect(await commit.promise).toBe('expired')
    })

    it('stays expired for a commit whose clock was captured before the lease ran out', async () => {
      const { stores, controls } = await fixture(5_000)
      const envelope = admitted(await stores.usage.reserve(KEY, 1))
      const held = await heldTransaction()
      const first = await held.query<{ result: string }>(STATEMENTS.commit, [
        envelope.reservationId,
        at(6_000).toISOString(),
      ])
      expect(first.rows[0]?.result).toBe('expired')

      // This one still holds the instant it captured before the lease ran out. Without the
      // fence it would re-evaluate the row against that instant and commit a slot the first
      // caller has already been told it lost.
      const slower = watch(stores.usage.commit(envelope.reservationId))
      await pause(WAIT_MS)
      expect(slower.settled()).toBe(false)
      await held.commit()

      expect(await slower.promise).toBe('expired')
      expect(await reservationStates()).toEqual(['pending'])
      const fenced = await pool.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM ${QUOTED}.usage_reservations WHERE reservation_id = $1`,
        [envelope.reservationId],
      )
      expect(fenced.rows[0]?.fenced_at).not.toBeNull()

      await controls.setTime(at(7_000))
      admitted(await stores.usage.reserve(KEY, 1))
      expect(await reservationStates()).toEqual(['expired', 'pending'])
    })
  })

  describe('a reserve queued behind the counter row', () => {
    // The lease here is a second, below the floor the factory enforces: this is a test of the
    // statement itself, where the question is when the lease starts rather than how long it is.
    const QUEUED = { operation: 'queued', subjectId: 'user-1' }

    it('gets a lease that starts when the slot was granted', async () => {
      await onRealTime()
      // A denied reserve first, so the counter row exists to be held.
      await pool.query(STATEMENTS.reserve, [QUEUED.operation, QUEUED.subjectId, 0, 1_000, null])
      const held = await heldTransaction()
      await held.query(
        `SELECT used FROM ${QUOTED}.usage_counters
          WHERE operation = $1 AND subject_id = $2 AND day = (now() AT TIME ZONE 'UTC')::date
          FOR UPDATE`,
        [QUEUED.operation, QUEUED.subjectId],
      )

      const sentAt = Date.now()
      const first = watch(
        pool.query<ReserveRow>(STATEMENTS.reserve, [
          QUEUED.operation,
          QUEUED.subjectId,
          1,
          1_000,
          null,
        ]),
      )
      await pause(1_600)
      const second = watch(
        pool.query<ReserveRow>(STATEMENTS.reserve, [
          QUEUED.operation,
          QUEUED.subjectId,
          1,
          1_000,
          null,
        ]),
      )
      await pause(WAIT_MS)
      await held.commit()

      const winner = (await first.promise).rows[0]
      const loser = (await second.promise).rows[0]
      expect(winner?.reservation_id).not.toBeNull()
      expect(loser?.reservation_id).toBeNull()
      // The lease of the winner is live: it started when the counter was granted, well after
      // the statement was sent, so the reserve behind it is right to report the slot as used.
      expect(Date.parse(winner?.expires_at ?? '')).toBeGreaterThan(sentAt + 1_500)
      expect(loser?.used).toBe(1)
    })

    it('caps a grant that lands after midnight at the end of the day it started in', async () => {
      // The formula of the statement, on its own: the grant clock is the day after the one the
      // statement began in, so both the grant and the lease land exactly on the reset.
      const { rows } = await pool.query<{ granted_at: string; expires_at: string }>(
        `WITH d AS (SELECT timestamptz '2026-01-16T00:00:00Z' AS resets_at),
              g AS (SELECT LEAST(timestamptz '2026-01-16T00:00:03Z', d.resets_at) AS granted_at
                      FROM d)
         SELECT to_char(g.granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at,
                to_char(LEAST(g.granted_at + make_interval(secs => 5000 / 1000.0), d.resets_at)
                        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
           FROM d, g`,
      )

      expect(rows[0]).toEqual({ granted_at: RESETS_AT, expires_at: RESETS_AT })
    })
  })

  describe('a pool set to a stricter isolation level', () => {
    it.each(['repeatable read', 'serializable'])('fails closed under %s', async (isolation) => {
      await onRealTime()
      const strict = createPool({
        options: `-c default_transaction_isolation=${isolation.replace(' ', '\\ ')}`,
        max: 12,
      })
      const { stores } = createPostgresStores({ pool: strict, schema: SCHEMA })

      try {
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, () => stores.usage.reserve(KEY, 3)),
        )
        const granted = results.filter(
          (result) => result.status === 'fulfilled' && result.value.ok,
        )
        const refused = results.flatMap((result) =>
          result.status === 'rejected' ? [sqlStateOf(result.reason)] : [],
        )

        expect(granted.length).toBeLessThanOrEqual(3)
        for (const state of refused) expect(['40001', '40P01']).toContain(state)
        expect((await stores.usage.snapshot(KEY)).used).toBe(granted.length)
      } finally {
        await strict.end()
      }
    })
  })
})
