/**
 * The usage-store conformance suite: one case per behaviour spec §8 requires, black box through
 * `UsageStore` plus the two controls a store cannot be checked without.
 *
 * @module
 */

import type { AttemptRecord, QuotaKey, ReservationEnvelope, UsageStore } from '../types'
import type {
  ConformanceCase,
  ConformancePreflight,
  ConformanceResult,
  Expectations,
} from './result'
import { rejects, runCases } from './result'

/** What `create()` hands over, named once so the cases can be typed. */
interface UsageControls {
  store: UsageStore
  setTime(date: Date): Promise<void>
  reset(): Promise<void>
  readSettled(reservationId: string): Promise<{
    reservation: ReservationEnvelope
    outcome: string
    attempts: AttemptRecord[]
  } | null>
}

type ReserveResult = Awaited<ReturnType<UsageStore['reserve']>>

/** Where every case starts. Midday, so a ten-minute lease can never reach the day boundary. */
const START = '2026-01-15T12:00:00.000Z'
const DAY = '2026-01-15'
const RESETS_AT = '2026-01-16T00:00:00.000Z'
const NEXT_DAY = '2026-01-16T12:00:00.000Z'

const KEY = { operation: 'conformance', subjectId: 'subject-1' }
const OTHER_KEY = { operation: 'conformance-other', subjectId: 'subject-2' }

/** The lease window the cases are written for: long enough to observe, short enough to lapse. */
const MIN_LEASE_MS = 100
const AFTER_LEASE_MS = 1_000

/** An id no store can have issued, in the shape a store is most likely to accept. */
const UNKNOWN_ID = '5b1f5b7c-2b1e-4a4e-9c2a-000000000000'

const RECORD: AttemptRecord = {
  provider: 'conformance-provider',
  model: 'conformance-model',
  outcome: 'succeeded',
  status: 200,
  usage: { inputTokens: 120, outputTokens: 34 },
  costUsd: 0.00042,
  durationMs: 250,
}

const FALLBACK_RECORD: AttemptRecord = {
  provider: 'conformance-provider',
  model: 'conformance-fallback',
  outcome: 'timeout',
  usage: null,
  costUsd: null,
  durationMs: 60_000,
}

/** The envelope of an admitted reserve, or `null` once the denial has been reported. */
function admitted(
  result: ReserveResult,
  expect: Expectations,
  what: string,
): ReservationEnvelope | null {
  if (result.ok) return result.reservation
  expect.that(false, `${what} to be admitted`, `it was denied with used ${String(result.used)}`)
  return null
}

/** The denial of a refused reserve, or `null` once the admission has been reported. */
function denied(
  result: ReserveResult,
  expect: Expectations,
  what: string,
): { used: number; resetsAt: string } | null {
  if (!result.ok) return result
  expect.that(false, `${what} to be denied`, 'it was admitted')
  return null
}

/** Checks a denial reports a count a caller can act on (spec §4). */
function checksDenial(
  denial: { used: number; resetsAt: string },
  used: number,
  expect: Expectations,
  what: string,
): void {
  expect.equal(denial.used, used, `the used reported by ${what}`)
  expect.that(
    Number.isSafeInteger(denial.used),
    `${what} to report used as a safe integer`,
    `it reported ${String(denial.used)}`,
  )
  expect.equal(denial.resetsAt, RESETS_AT, `the reset reported by ${what}`)
}

/** Requires a key with no live usage to admit one reserve at limit 1 and refuse the next. */
async function admitsExactlyOnce(
  controls: UsageControls,
  expect: Expectations,
  what: string,
): Promise<void> {
  admitted(await controls.store.reserve(KEY, 1), expect, `the first reserve ${what}`)
  denied(await controls.store.reserve(KEY, 1), expect, `the second reserve ${what}`)
}

/** Moves the clock just past a lease that has been handed out. */
async function afterLease(controls: UsageControls, expiresAt: string): Promise<void> {
  await controls.setTime(new Date(Date.parse(expiresAt) + AFTER_LEASE_MS))
}

/**
 * The one assumption every case makes: a lease long enough to be seen and short enough to run
 * out inside the store's day.
 */
const LEASE_WINDOW: ConformancePreflight<UsageControls> = {
  name: 'lease-window',
  async check(controls) {
    const result = await controls.store.reserve(KEY, 1)
    // A store that denies the first reserve of a day has a problem the cases describe better.
    if (!result.ok) return null
    const endsAt = Date.parse(result.expiresAt)
    if (Number.isNaN(endsAt)) {
      return `the lease to be an ISO instant but it was ${result.expiresAt}`
    }
    const lease = endsAt - Date.parse(START)
    if (lease < MIN_LEASE_MS) {
      return `a lease of at least ${String(MIN_LEASE_MS)} ms, which the suite needs to observe one, but it was ${String(lease)} ms`
    }
    if (endsAt + AFTER_LEASE_MS >= Date.parse(RESETS_AT)) {
      return `a lease that runs out well inside the day, which the suite needs to watch one lapse, but it ran to ${result.expiresAt}`
    }
    return null
  },
}

/**
 * Settles a reservation and requires that settlement changed no accounting.
 *
 * Run for a pending, a committed, an expired and an unknown reservation: settlement records
 * what happened, and never refunds or invents a slot (spec §4).
 */
async function settlesWithoutMovingAccounting(
  controls: UsageControls,
  expect: Expectations,
  envelope: ReservationEnvelope,
  what: string,
): Promise<void> {
  const { store } = controls
  const before = await store.snapshot(KEY)

  await store.settle(envelope, 'succeeded', [RECORD])
  const recorded = await controls.readSettled(envelope.reservationId)
  expect.that(
    recorded !== null,
    `settling a ${what} reservation to record it`,
    'readSettled found nothing',
  )
  expect.equal(recorded?.reservation, envelope, 'the recorded envelope')
  expect.equal(recorded?.outcome, 'succeeded', 'the recorded outcome')
  expect.equal(recorded?.attempts, [RECORD], 'the recorded attempts')

  await store.settle(envelope, 'succeeded', [RECORD])
  await store.settle(envelope, 'failed', [FALLBACK_RECORD])
  const retained = await controls.readSettled(envelope.reservationId)
  expect.equal(retained?.outcome, 'succeeded', 'the outcome after a conflicting retry')
  expect.equal(
    await store.snapshot(KEY),
    before,
    `the snapshot after settling a ${what} reservation`,
  )
}

const CASES: readonly ConformanceCase<UsageControls>[] = [
  {
    name: 'reserve-atomicity',
    async run({ store }, expect) {
      const limit = 3
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.reserve(KEY, limit)),
      )
      const envelopes = results.flatMap((result) => (result.ok ? [result.reservation] : []))
      const denials = results.flatMap((result) => (result.ok ? [] : [result]))

      expect.equal(envelopes.length, limit, 'the number of reserves admitted at limit 3')
      expect.equal(
        new Set(envelopes.map((envelope) => envelope.reservationId)).size,
        envelopes.length,
        'the number of distinct reservation ids',
      )
      for (const denial of denials)
        checksDenial(denial, limit, expect, 'a denial past the limit')
    },
  },
  {
    name: 'reservation-ids-globally-unique',
    async run(controls, expect) {
      const { store } = controls
      const issued: { requested: QuotaKey; envelope: ReservationEnvelope }[] = []
      for (const requested of [KEY, OTHER_KEY]) {
        for (let index = 0; index < 2; index += 1) {
          const result = await store.reserve(requested, 2)
          if (result.ok) issued.push({ requested, envelope: result.reservation })
        }
      }
      await controls.setTime(new Date(NEXT_DAY))
      for (const requested of [KEY, OTHER_KEY]) {
        const result = await store.reserve(requested, 2)
        if (result.ok) issued.push({ requested, envelope: result.reservation })
      }

      expect.equal(issued.length, 6, 'the number of reserves admitted across two keys and days')
      expect.equal(
        new Set(issued.map(({ envelope }) => envelope.reservationId)).size,
        issued.length,
        'the number of distinct ids across keys and days',
      )
      // Read at the end, not as each one arrives: an envelope that shares one mutable key with
      // every other envelope only shows it once a later reserve has moved on to another key.
      for (const { requested, envelope } of issued) {
        expect.equal(
          envelope.key,
          requested,
          `the key an envelope for '${requested.operation}' still carries at the end of the run`,
        )
      }
    },
  },
  {
    name: 'commit-idempotent',
    async run({ store }, expect) {
      const envelope = admitted(await store.reserve(KEY, 1), expect, 'the first reserve')
      if (envelope === null) return
      expect.equal(await store.commit(envelope.reservationId), 'committed', 'the first commit')
      expect.equal(await store.commit(envelope.reservationId), 'committed', 'the second commit')

      const live = admitted(await store.reserve(KEY, 2), expect, 'a second reserve')
      if (live === null) return
      expect.equal(
        await Promise.all([store.commit(live.reservationId), store.commit(live.reservationId)]),
        ['committed', 'committed'],
        'two commits of one pending reservation issued at once',
      )
    },
  },
  {
    name: 'commit-lost-ack-retry',
    async run(controls, expect) {
      const { store } = controls
      const result = await store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the reserve')
      if (envelope === null || !result.ok) return
      await store.commit(envelope.reservationId)
      // The acknowledgement was lost: the caller retries after the lease would have run out.
      await afterLease(controls, result.expiresAt)
      expect.equal(
        await store.commit(envelope.reservationId),
        'committed',
        'a commit retried after the lease ran out',
      )
      expect.equal((await store.snapshot(KEY)).used, 1, 'the slots used after the retry')
    },
  },
  {
    name: 'commit-unknown-missing',
    async run({ store }, expect) {
      expect.equal(await store.commit(UNKNOWN_ID), 'missing', 'a commit of an id never issued')
    },
  },
  {
    name: 'commit-lapsed-expired',
    async run(controls, expect) {
      const { store } = controls
      const result = await store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the reserve')
      if (envelope === null || !result.ok) return
      await afterLease(controls, result.expiresAt)
      expect.equal(
        await store.commit(envelope.reservationId),
        'expired',
        'a commit after the lease ran out',
      )
      expect.equal(
        await store.commit(envelope.reservationId),
        'expired',
        'every later commit of that reservation',
      )
    },
  },
  {
    name: 'commit-reclaimed-expired',
    async run(controls, expect) {
      const { store } = controls
      const result = await store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the first reserve')
      if (envelope === null || !result.ok) return
      await afterLease(controls, result.expiresAt)
      // The next reserve takes the lapsed slot back before the first caller commits.
      admitted(await store.reserve(KEY, 1), expect, 'the reserve that reclaims the lapsed slot')
      for (const attempt of [1, 2, 3]) {
        expect.equal(
          await store.commit(envelope.reservationId),
          'expired',
          `commit number ${String(attempt)} of a reclaimed reservation`,
        )
      }
    },
  },
  {
    name: 'settle-idempotent',
    async run(controls, expect) {
      const { store } = controls
      const envelope = admitted(await store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      await store.settle(envelope, 'succeeded', [RECORD])
      await store.settle(envelope, 'succeeded', [RECORD])
      const recorded = await controls.readSettled(envelope.reservationId)
      expect.equal(recorded?.outcome, 'succeeded', 'the outcome after settling twice')
      expect.equal(recorded?.attempts, [RECORD], 'the attempts after settling twice')
    },
  },
  {
    name: 'settle-duplicate-conflict-first-write-wins',
    async run(controls, expect) {
      const { store } = controls
      const envelope = admitted(await store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      await store.settle(envelope, 'succeeded', [RECORD])
      // Everything about the retry differs, so nothing about it can survive by looking alike.
      await store.settle(
        { reservationId: envelope.reservationId, key: OTHER_KEY, day: NEXT_DAY.slice(0, 10) },
        'failed',
        [FALLBACK_RECORD],
      )
      expect.equal(
        await controls.readSettled(envelope.reservationId),
        { reservation: envelope, outcome: 'succeeded', attempts: [RECORD] },
        'the settlement after a conflicting retry',
      )

      const second = admitted(await store.reserve(KEY, 2), expect, 'a second reserve')
      if (second === null) return
      await Promise.all([
        store.settle(second, 'succeeded', [RECORD]),
        store.settle(second, 'failed', [FALLBACK_RECORD]),
      ])
      const raced = await controls.readSettled(second.reservationId)
      const persisted =
        raced?.outcome === 'succeeded'
          ? { outcome: 'succeeded', attempts: [RECORD] }
          : { outcome: 'failed', attempts: [FALLBACK_RECORD] }
      expect.equal(
        { outcome: raced?.outcome, attempts: raced?.attempts },
        persisted,
        'one whole payload of two settled at once',
      )
      await store.settle(second, 'succeeded', [FALLBACK_RECORD])
      expect.equal(
        { outcome: raced?.outcome, attempts: raced?.attempts },
        {
          outcome: (await controls.readSettled(second.reservationId))?.outcome,
          attempts: (await controls.readSettled(second.reservationId))?.attempts,
        },
        'that payload after a later retry',
      )
    },
  },
  {
    name: 'settle-known-pending',
    async run(controls, expect) {
      const envelope = admitted(await controls.store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      await settlesWithoutMovingAccounting(controls, expect, envelope, 'pending')
    },
  },
  {
    name: 'settle-known-committed',
    async run(controls, expect) {
      const envelope = admitted(await controls.store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      await controls.store.commit(envelope.reservationId)
      await settlesWithoutMovingAccounting(controls, expect, envelope, 'committed')
    },
  },
  {
    name: 'settle-known-expired',
    async run(controls, expect) {
      const result = await controls.store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the reserve')
      if (envelope === null || !result.ok) return
      await afterLease(controls, result.expiresAt)
      await settlesWithoutMovingAccounting(controls, expect, envelope, 'expired')
      await admitsExactlyOnce(controls, expect, 'after settling an expired reservation')
    },
  },
  {
    name: 'settle-unknown-accounting',
    async run(controls, expect) {
      const envelope: ReservationEnvelope = { reservationId: UNKNOWN_ID, key: KEY, day: DAY }
      await settlesWithoutMovingAccounting(controls, expect, envelope, 'unknown')
      await admitsExactlyOnce(controls, expect, 'after settling an unknown reservation')
    },
  },
  {
    name: 'settle-unknown-recorded',
    async run(controls, expect) {
      const envelope: ReservationEnvelope = {
        reservationId: UNKNOWN_ID,
        key: OTHER_KEY,
        day: DAY,
      }
      await controls.store.settle(envelope, 'failed', [FALLBACK_RECORD])
      const recorded = await controls.readSettled(UNKNOWN_ID)
      expect.equal(
        recorded?.reservation,
        envelope,
        "an unknown reservation to be recorded against the envelope's key and day",
      )
      expect.equal(recorded?.outcome, 'failed', 'the recorded outcome')
    },
  },
  {
    name: 'settle-round-trip',
    async run(controls, expect) {
      const envelope = admitted(await controls.store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      const attempts = [RECORD, FALLBACK_RECORD]
      await controls.store.settle(envelope, 'failed', attempts)
      const recorded = await controls.readSettled(envelope.reservationId)
      expect.equal(recorded?.attempts, attempts, 'the attempt records read back')
    },
  },
  {
    name: 'lease-expiry-frees-pending',
    async run(controls, expect) {
      const { store } = controls
      const result = await store.reserve(KEY, 1)
      if (admitted(result, expect, 'the first reserve') === null || !result.ok) return
      denied(await store.reserve(KEY, 1), expect, 'a reserve while the first is live')
      await afterLease(controls, result.expiresAt)
      admitted(await store.reserve(KEY, 1), expect, 'a reserve after the lease ran out')
      expect.equal((await store.snapshot(KEY)).used, 1, 'the slots used after the lapse')
    },
  },
  {
    name: 'lease-never-frees-committed',
    async run(controls, expect) {
      const { store } = controls
      const result = await store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the reserve')
      if (envelope === null || !result.ok) return
      await store.commit(envelope.reservationId)
      await afterLease(controls, result.expiresAt)
      const denial = denied(
        await store.reserve(KEY, 1),
        expect,
        'a reserve after a committed slot outlived its lease',
      )
      if (denial !== null) checksDenial(denial, 1, expect, 'that denial')
      expect.equal((await store.snapshot(KEY)).used, 1, 'the slots used by a committed run')
    },
  },
  {
    name: 'lease-capped-at-day-boundary',
    async run(controls, expect) {
      await controls.setTime(new Date('2026-01-15T23:59:59.900Z'))
      const result = await controls.store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'a reserve just before midnight')
      if (envelope === null || !result.ok) return
      expect.equal(result.expiresAt, RESETS_AT, 'a lease that would cross the day boundary')
      expect.equal(envelope.day, DAY, "the envelope's day")

      // The cap is only a claim until the clock passes it.
      await controls.setTime(new Date('2026-01-16T00:00:01.000Z'))
      expect.equal(
        await controls.store.commit(envelope.reservationId),
        'expired',
        "a commit of yesterday's reservation once the day has turned",
      )
    },
  },
  {
    name: 'day-rollover',
    async run(controls, expect) {
      const { store } = controls
      admitted(await store.reserve(KEY, 1), expect, 'the reserve on the first day')
      await controls.setTime(new Date(NEXT_DAY))
      const snapshot = await store.snapshot(KEY)
      expect.equal(snapshot.used, 0, 'the slots used on the new day')
      expect.equal(snapshot.resetsAt, '2026-01-17T00:00:00.000Z', "the new day's reset")
      const envelope = admitted(await store.reserve(KEY, 1), expect, 'a reserve on the new day')
      expect.equal(envelope?.day, '2026-01-16', "the new day's envelope day")
    },
  },
  {
    name: 'snapshot-includes-pending',
    async run({ store }, expect) {
      admitted(await store.reserve(KEY, 2), expect, 'the reserve')
      const snapshot = await store.snapshot(KEY)
      expect.equal(snapshot.used, 1, 'the slots used by a pending reservation')
      expect.that(
        Number.isSafeInteger(snapshot.used),
        'a snapshot to report used as a safe integer',
        `it reported ${String(snapshot.used)}`,
      )
      expect.equal(snapshot.resetsAt, RESETS_AT, "the snapshot's reset")
    },
  },
  {
    name: 'envelope-key-matches',
    async run({ store }, expect) {
      const envelope = admitted(await store.reserve(KEY, 1), expect, 'the reserve')
      if (envelope === null) return
      expect.equal(envelope.key, KEY, "the envelope's key")
      expect.that(
        typeof envelope.reservationId === 'string' && envelope.reservationId !== '',
        'the envelope to carry a non-empty reservation id',
        `it carried '${envelope.reservationId}'`,
      )
    },
  },
  {
    name: 'envelope-day-format',
    async run({ store }, expect) {
      const result = await store.reserve(KEY, 1)
      const envelope = admitted(result, expect, 'the reserve')
      if (envelope === null || !result.ok) return
      expect.equal(envelope.day, DAY, "the envelope's day, as YYYY-MM-DD in UTC")
      expect.that(
        new Date(result.expiresAt).toISOString() === result.expiresAt,
        'the lease to be reported as an ISO instant',
        `it was reported as ${result.expiresAt}`,
      )
    },
  },
  {
    name: 'reserve-limit-zero-consumes-nothing',
    async run({ store }, expect) {
      const denial = denied(await store.reserve(KEY, 0), expect, 'a reserve at limit 0')
      if (denial !== null) checksDenial(denial, 0, expect, 'a reserve at limit 0')
      expect.equal((await store.snapshot(KEY)).used, 0, 'the slots used after a zero limit')
      // Nothing was consumed, so the next caller with an allowance gets the day's first slot.
      const envelope = admitted(
        await store.reserve(KEY, 1),
        expect,
        'a following reserve at limit 1',
      )
      if (envelope === null) return
      await store.commit(envelope.reservationId)

      // The same at a limit of zero on a key that has been used: a denial, and nothing moved.
      const before = await store.snapshot(KEY)
      const used = denied(
        await store.reserve(KEY, 0),
        expect,
        'a reserve at limit 0 on a used key',
      )
      if (used !== null) checksDenial(used, 1, expect, 'a reserve at limit 0 on a used key')
      expect.equal(await store.snapshot(KEY), before, 'the snapshot after that denial')
      expect.equal(
        await store.commit(envelope.reservationId),
        'committed',
        'a commit of the committed reservation after that denial',
      )
    },
  },
  {
    name: 'limit-lowered-below-usage-denies',
    async run({ store }, expect) {
      const first = admitted(await store.reserve(KEY, 2), expect, 'the first reserve')
      const second = admitted(await store.reserve(KEY, 2), expect, 'the second reserve')
      if (first === null || second === null) return
      await store.commit(first.reservationId)

      const denial = denied(
        await store.reserve(KEY, 1),
        expect,
        'a reserve at the lowered limit',
      )
      if (denial !== null) checksDenial(denial, 2, expect, 'a reserve at the lowered limit')
      expect.equal(
        await store.commit(second.reservationId),
        'committed',
        'a commit of the pending reservation after the denial',
      )
      expect.equal(
        await store.commit(first.reservationId),
        'committed',
        'a commit of the committed reservation after the denial',
      )
      expect.equal((await store.snapshot(KEY)).used, 2, 'the slots used after the denial')
    },
  },
  {
    name: 'returned-values-detached',
    async run(controls, expect) {
      const { store } = controls
      const envelope = admitted(await store.reserve(KEY, 2), expect, 'the reserve')
      if (envelope === null) return
      const { reservationId } = envelope

      // Editing what the store handed back must not edit what the store holds.
      envelope.key.operation = 'edited-after-reserve'
      envelope.key.subjectId = 'edited-after-reserve'
      envelope.day = '1999-01-01'
      expect.equal(
        (await store.snapshot(KEY)).used,
        1,
        'the slots used after the caller edited the envelope it was given',
      )
      expect.equal(
        await store.commit(reservationId),
        'committed',
        'a commit after the caller edited the envelope it was given',
      )

      const attempts = [{ ...RECORD }]
      await store.settle({ reservationId, key: KEY, day: DAY }, 'succeeded', attempts)
      const edited = attempts[0]
      if (edited !== undefined) edited.model = 'edited-after-settle'
      attempts.push({ ...FALLBACK_RECORD })
      const read = await controls.readSettled(reservationId)
      const record = read?.attempts[0]
      if (record !== undefined) record.provider = 'edited-after-read'
      expect.equal(
        (await controls.readSettled(reservationId))?.attempts,
        [RECORD],
        'the attempts settled once the caller had edited both the array and what it read',
      )
    },
  },
  {
    name: 'rejects-out-of-domain-strings',
    async run({ store }, expect) {
      // Spec §6: well-formed Unicode, no U+0000, at most 1 000 bytes of UTF-8. A store that
      // repaired one of these would hold a key nobody asked about.
      const nul = 'a\u0000b'
      const envelope: ReservationEnvelope = { reservationId: UNKNOWN_ID, key: KEY, day: DAY }
      const persisted = [
        {
          field: 'the operation of a reserve',
          call: () => store.reserve({ ...KEY, operation: nul }, 1),
        },
        {
          field: 'the subject of a reserve',
          call: () => store.reserve({ ...KEY, subjectId: nul }, 1),
        },
        {
          field: "a settlement's reservation id",
          call: () => store.settle({ ...envelope, reservationId: nul }, 'succeeded', [RECORD]),
        },
        {
          field: "a settlement's operation",
          call: () =>
            store.settle({ ...envelope, key: { ...KEY, operation: nul } }, 'succeeded', [
              RECORD,
            ]),
        },
        {
          field: "a settlement's subject",
          call: () =>
            store.settle({ ...envelope, key: { ...KEY, subjectId: nul } }, 'succeeded', [
              RECORD,
            ]),
        },
        {
          field: "a settlement's day",
          call: () => store.settle({ ...envelope, day: nul }, 'succeeded', [RECORD]),
        },
        {
          field: "an attempt's provider",
          call: () => store.settle(envelope, 'succeeded', [{ ...RECORD, provider: nul }]),
        },
        {
          field: "an attempt's model",
          call: () => store.settle(envelope, 'succeeded', [{ ...RECORD, model: nul }]),
        },
      ]
      for (const { field, call } of persisted) {
        await rejects(call, expect, `${field} holding U+0000`)
      }

      // The whole rule, on one field: a lone surrogate and a byte too many are refused as well.
      for (const value of [nul, 'a\ud800b', `${'\u20ac'.repeat(333)}ab`]) {
        await rejects(
          () => store.reserve({ ...KEY, operation: value }, 1),
          expect,
          `a reserve for the operation ${JSON.stringify(value)}`,
        )
      }
      admitted(
        await store.reserve({ ...KEY, subjectId: `${'\u20ac'.repeat(333)}a` }, 1),
        expect,
        'a reserve for a subject of exactly 1 000 bytes',
      )
    },
  },
]

/**
 * Checks a `UsageStore` against the behaviour spec §8 requires of one.
 *
 * Framework-free: call it from any test runner or from a script, and read the result. Every
 * case starts from `reset()` and a fixed clock, so the verdict does not depend on the order
 * anything ran in. `setTime` is only ever called with instants that do not move the store's
 * clock backwards between resets. The store's lease must be at least 100 ms and short enough
 * to lapse before the store's day ends, which is checked first and reported as `lease-window`.
 *
 * @param opts `create` builds the store under test and the controls the suite drives it with.
 * @returns Every failure, each prefixed with the case that reported it.
 *
 * @example
 * ```ts
 * const result = await runUsageStoreConformance({ create: () => buildMyStore() })
 * if (!result.passed) throw new Error(result.failures.join('\n'))
 * ```
 */
export function runUsageStoreConformance(opts: {
  create(): Promise<{
    store: UsageStore
    setTime(date: Date): Promise<void>
    reset(): Promise<void>
    readSettled(reservationId: string): Promise<{
      reservation: ReservationEnvelope
      outcome: string
      attempts: AttemptRecord[]
    } | null>
  }>
}): Promise<ConformanceResult> {
  return runCases(
    () => opts.create(),
    async (controls) => {
      await controls.reset()
      await controls.setTime(new Date(START))
    },
    CASES,
    LEASE_WINDOW,
  )
}
