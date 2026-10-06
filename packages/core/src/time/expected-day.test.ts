import { afterEach, describe, expect, it } from 'vitest';

import { restoreIntl, useHermesLikeIntl } from './__fixtures__/hermes-like-intl';
import {
  expectedDayOf,
  isPastExpectedDay,
  orgDayOf,
  pastExpectedDayCutoff,
} from './calendar-date';

/**
 * WHEN A PURCHASE ORDER IS OVERDUE, AND A DELIVERY LATE (owner rule, 2026-10-06).
 *
 * A purchase order's expected date is the DAY the buyer picked, stored as that
 * day's midnight UTC (every writer; production 2026-10-06: all 34 at 00:00
 * UTC). The overdue checks compared that stored midnight with the current
 * instant, so a purchase order expected Oct 10 counted as overdue from 5 PM
 * Pacific on Oct 9, the evening BEFORE its expected day, and in Sydney from
 * 11 AM on the expected day itself. The supplier scorecard compared it with
 * the receipt instant, so a delivery received ON its expected day was late.
 *
 * The rule: a purchase order is overdue when the organization's current date
 * (organizations.timezone) is AFTER its expected day; a delivery is late when
 * it was received on a day (in the organization's zone) after the expected
 * day. The expected day itself is never overdue or late.
 *
 * ONE RULE: isPastExpectedDay is the predicate, and pastExpectedDayCutoff is the
 * same rule as an instant a database filter compares with (`expected_at <
 * cutoff`). The sweep below pins that the two agree on every instant.
 *
 * Run with the process in Los Angeles, at UTC and in Sydney (the tests also
 * switch process.env.TZ themselves): nothing here may depend on the zone the
 * runtime (a phone, a server, a browser) is in.
 */

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';
const PROCESS_ZONES = [LA, 'UTC', SYDNEY];

/** Expected Oct 10, as every writer stores it. */
const OCT_10 = '2026-10-10T00:00:00.000Z';

type Case = [at: string, when: string, past: boolean];

/** An organization in Los Angeles (PDT, UTC-7, in October). */
const LOS_ANGELES_CASES: Case[] = [
  ['2026-10-10T00:30:00.000Z', 'Oct 9, 5:30 PM PDT (the evening before)', false],
  ['2026-10-10T06:59:59.999Z', 'Oct 9, 11:59:59 PM PDT (the last instant before)', false],
  ['2026-10-10T07:00:00.000Z', 'Oct 10, 12:00 AM PDT (the expected day begins)', false],
  ['2026-10-10T19:00:00.000Z', 'Oct 10, noon PDT', false],
  ['2026-10-11T06:59:59.999Z', 'Oct 10, 11:59:59 PM PDT (the last instant of it)', false],
  ['2026-10-11T07:00:00.000Z', 'Oct 11, 12:00 AM PDT (the next day)', true],
];

/** An organization in Sydney (AEDT, UTC+11, from Oct 4 2026). */
const SYDNEY_CASES: Case[] = [
  ['2026-10-09T09:00:00.000Z', 'Oct 9, 8:00 PM AEDT (the evening before)', false],
  ['2026-10-09T13:00:00.000Z', 'Oct 10, 12:00 AM AEDT (the expected day begins)', false],
  ['2026-10-10T01:00:00.000Z', 'Oct 10, noon AEDT', false],
  ['2026-10-10T12:59:59.999Z', 'Oct 10, 11:59:59 PM AEDT (the last instant of it)', false],
  ['2026-10-10T13:00:00.000Z', 'Oct 11, 12:00 AM AEDT (the next day)', true],
];

describe('when a purchase order is past its expected day', () => {
  const previousZone = process.env.TZ;
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
    restoreIntl();
  });

  // What every overdue check did before: the stored midnight against the
  // instant. In Los Angeles it is already "past" at 5:30 PM the evening
  // before; in Sydney at noon on the expected day itself.
  it('the old comparison of instants called it overdue the evening before (Los Angeles) and on the day (Sydney)', () => {
    expect(new Date(OCT_10) < new Date('2026-10-10T00:30:00.000Z')).toBe(true);
    expect(new Date(OCT_10) < new Date('2026-10-10T01:00:00.000Z')).toBe(true);
  });

  it('in a Los Angeles organization: not the evening before, not on the expected day, from the next day', () => {
    for (const zone of PROCESS_ZONES) {
      process.env.TZ = zone;
      for (const [at, when, past] of LOS_ANGELES_CASES) {
        expect(isPastExpectedDay(OCT_10, at, LA), `${when}, process in ${zone}`).toBe(past);
        expect(isPastExpectedDay(OCT_10, new Date(at), LA), `${when} as a Date`).toBe(past);
      }
    }
  });

  it('in a Sydney organization: not the evening before, not on the expected day, from the next day', () => {
    for (const zone of PROCESS_ZONES) {
      process.env.TZ = zone;
      for (const [at, when, past] of SYDNEY_CASES) {
        expect(isPastExpectedDay(OCT_10, at, SYDNEY), `${when}, process in ${zone}`).toBe(past);
      }
    }
  });

  it('turns over at the organization’s midnight across both daylight-saving changes', () => {
    const cases: Array<[expected: string, lastInstant: string, firstPast: string, zone: string]> = [
      // US clocks spring forward on Mar 8 and fall back on Nov 1, 2026.
      ['2026-03-08T00:00:00.000Z', '2026-03-09T06:59:59.999Z', '2026-03-09T07:00:00.000Z', LA],
      ['2026-11-01T00:00:00.000Z', '2026-11-02T07:59:59.999Z', '2026-11-02T08:00:00.000Z', LA],
      // Sydney falls back on Apr 5 and springs forward on Oct 4, 2026.
      ['2026-04-05T00:00:00.000Z', '2026-04-05T13:59:59.999Z', '2026-04-05T14:00:00.000Z', SYDNEY],
      ['2026-10-04T00:00:00.000Z', '2026-10-04T12:59:59.999Z', '2026-10-04T13:00:00.000Z', SYDNEY],
    ];
    for (const processZone of PROCESS_ZONES) {
      process.env.TZ = processZone;
      for (const [expected, lastInstant, firstPast, zone] of cases) {
        expect(isPastExpectedDay(expected, lastInstant, zone), `${expected} at ${lastInstant}`).toBe(
          false,
        );
        expect(isPastExpectedDay(expected, firstPast, zone), `${expected} at ${firstPast}`).toBe(true);
      }
    }
  });

  it('is a delivery received on its expected day on time, and one received the next organization day late', () => {
    // The scorecard compared received_at <= expected_at, so a delivery
    // received at 3 PM on its expected day counted as late.
    const receivedOnTheDay = '2026-10-10T22:00:00.000Z'; // Oct 10, 3 PM PDT
    expect(new Date(receivedOnTheDay) <= new Date(OCT_10)).toBe(false);
    expect(isPastExpectedDay(OCT_10, receivedOnTheDay, LA)).toBe(false);
    // 11 PM in Los Angeles is Oct 11 in UTC: still the expected day there.
    expect(isPastExpectedDay(OCT_10, '2026-10-11T06:00:00.000Z', LA)).toBe(false);
    expect(isPastExpectedDay(OCT_10, '2026-10-11T16:00:00.000Z', LA)).toBe(true); // Oct 11, 9 AM
    expect(isPastExpectedDay(OCT_10, '2026-10-09T18:00:00.000Z', LA)).toBe(false); // the day before
    // 2 PM on the expected day in Sydney is 03:00 UTC, after the stored midnight.
    expect(isPastExpectedDay(OCT_10, '2026-10-10T03:00:00.000Z', SYDNEY)).toBe(false);
    expect(isPastExpectedDay(OCT_10, '2026-10-10T21:00:00.000Z', SYDNEY)).toBe(true); // Oct 11, 8 AM
  });

  it('gives the database the same rule: expected_at before the organization’s today at midnight UTC', () => {
    expect(pastExpectedDayCutoff('2026-10-10T00:30:00.000Z', LA)).toBe('2026-10-09T00:00:00.000Z');
    expect(pastExpectedDayCutoff('2026-10-10T19:00:00.000Z', LA)).toBe('2026-10-10T00:00:00.000Z');
    expect(pastExpectedDayCutoff('2026-10-11T07:00:00.000Z', LA)).toBe('2026-10-11T00:00:00.000Z');
    expect(pastExpectedDayCutoff('2026-10-10T01:00:00.000Z', SYDNEY)).toBe('2026-10-10T00:00:00.000Z');
    expect(pastExpectedDayCutoff('2026-10-10T13:00:00.000Z', SYDNEY)).toBe('2026-10-11T00:00:00.000Z');
    expect(pastExpectedDayCutoff(new Date('2026-10-10T19:00:00.000Z'), LA)).toBe(
      '2026-10-10T00:00:00.000Z',
    );
  });

  // The pin that keeps the predicate and the database filter one rule: for
  // every instant in five days (every 15 minutes) and every stored value
  // (midnights, and values a writer could store off midnight), in zones on
  // both sides of UTC and at its far ends.
  it('ONE RULE: isPastExpectedDay agrees with `expected_at < pastExpectedDayCutoff` on every instant', () => {
    const stored = [
      '2026-10-07T00:00:00.000Z',
      '2026-10-08T00:00:00.000Z',
      '2026-10-09T00:00:00.000Z',
      OCT_10,
      '2026-10-11T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
      '2026-10-10T00:00:00Z',
      '2026-10-10T07:00:00.000Z',
      '2026-10-10T12:00:00+00:00',
      '2026-10-10T23:59:59.999Z',
      '2026-10-09T23:59:59.999Z',
    ];
    const zones = [LA, SYDNEY, 'UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    const start = Date.parse('2026-10-08T00:00:00.000Z');
    const end = Date.parse('2026-10-13T00:00:00.000Z');
    let checked = 0;
    for (const zone of zones) {
      for (let t = start; t <= end; t += 15 * 60 * 1000) {
        const cutoff = pastExpectedDayCutoff(t, zone);
        expect(cutoff, `${new Date(t).toISOString()} in ${zone}`).not.toBeNull();
        for (const e of stored) {
          expect(isPastExpectedDay(e, t, zone), `${e} at ${new Date(t).toISOString()} in ${zone}`).toBe(
            Date.parse(e) < Date.parse(cutoff!),
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(zones.length * (((end - start) / (15 * 60 * 1000)) + 1) * stored.length);
  });

  it('is never past for a missing or unreadable date or instant', () => {
    for (const e of [null, undefined, '', 'not a date']) {
      expect(isPastExpectedDay(e, '2026-12-31T00:00:00.000Z', LA), String(e)).toBe(false);
    }
    for (const at of [null, undefined, '', 'not a date', Number.NaN]) {
      expect(isPastExpectedDay(OCT_10, at, LA), String(at)).toBe(false);
      expect(pastExpectedDayCutoff(at as never, LA), String(at)).toBeNull();
    }
  });

  it("an unset or unknown zone is the documented default (resolveOrgTimezone's), never a throw", () => {
    for (const zone of [null, undefined, '', '   ', 'Mars/Olympus_Mons']) {
      expect(isPastExpectedDay(OCT_10, '2026-10-10T00:30:00.000Z', zone), String(zone)).toBe(false);
      expect(isPastExpectedDay(OCT_10, '2026-10-11T07:00:00.000Z', zone), String(zone)).toBe(true);
    }
  });

  it("answers the same through the phone's engine (the Hermes stand-in)", () => {
    process.env.TZ = LA;
    useHermesLikeIntl();
    for (const [at, when, past] of LOS_ANGELES_CASES) {
      expect(isPastExpectedDay(OCT_10, at, LA), when).toBe(past);
    }
    for (const [at, when, past] of SYDNEY_CASES) {
      expect(isPastExpectedDay(OCT_10, at, SYDNEY), when).toBe(past);
    }
    expect(pastExpectedDayCutoff('2026-10-10T00:30:00.000Z', LA)).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('expectedDayOf: the stored day, read in UTC', () => {
  const previousZone = process.env.TZ;
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  it('is the day that was set, whatever zone the process is in', () => {
    for (const zone of PROCESS_ZONES) {
      process.env.TZ = zone;
      expect(expectedDayOf(OCT_10), zone).toBe('2026-10-10');
      expect(expectedDayOf(new Date(OCT_10)), zone).toBe('2026-10-10');
      expect(expectedDayOf('2026-01-01T00:00:00Z'), zone).toBe('2026-01-01');
      expect(expectedDayOf('2026-12-31T00:00:00.000Z'), zone).toBe('2026-12-31');
    }
  });

  it('is null for a missing or unreadable value', () => {
    expect(expectedDayOf(null)).toBeNull();
    expect(expectedDayOf(undefined)).toBeNull();
    expect(expectedDayOf('')).toBeNull();
    expect(expectedDayOf('not a date')).toBeNull();
  });
});

describe("orgDayOf: the day an instant falls on in the organization's zone", () => {
  it('is the wall-calendar day there, not the UTC day', () => {
    expect(orgDayOf('2026-10-10T00:30:00.000Z', LA)).toBe('2026-10-09');
    expect(orgDayOf('2026-10-10T07:00:00.000Z', LA)).toBe('2026-10-10');
    expect(orgDayOf('2026-10-09T13:00:00.000Z', SYDNEY)).toBe('2026-10-10');
    expect(orgDayOf(Date.parse('2026-10-10T00:30:00.000Z'), 'UTC')).toBe('2026-10-10');
    expect(orgDayOf(new Date('2026-12-31T23:30:00.000Z'), SYDNEY)).toBe('2027-01-01');
  });

  it('is null for an unreadable instant', () => {
    expect(orgDayOf('not a date', LA)).toBeNull();
    expect(orgDayOf(Number.NaN, LA)).toBeNull();
  });
});
