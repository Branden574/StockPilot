import { describe, expect, it } from 'vitest';

import {
  eventInputFromInstant,
  eventInstantFromInput,
  eventInstantsFromInputs,
  wallClockOccurrences,
} from './event-wall-clock';

/**
 * The hour the clocks go back, in zones on both sides of UTC (small fixes
 * slice 8 review). Core's conversion answers the FIRST occurrence west of
 * UTC and the SECOND east of it and at UTC+0, so an unchanged save moved an
 * event at the other one an hour earlier in Los Angeles and an hour LATER in
 * London. eventInstantsFromInputs keeps a field's stored instant while the
 * field still shows it.
 */

const at = (iso: string) => Date.parse(iso);
const wall = (s: string) => {
  const [d, t] = s.split('T') as [string, string];
  const [year, month, day] = d.split('-').map(Number) as [number, number, number];
  const [hour, minute] = t.split(':').map(Number) as [number, number];
  return { year, month, day, hour, minute };
};

describe('wallClockOccurrences', () => {
  it('finds both instants of a wall clock in the repeated hour, earliest first', () => {
    expect(wallClockOccurrences(wall('2026-11-01T01:30'), 'America/Los_Angeles')).toEqual([
      at('2026-11-01T08:30:00Z'),
      at('2026-11-01T09:30:00Z'),
    ]);
    expect(wallClockOccurrences(wall('2026-10-25T01:30'), 'Europe/London')).toEqual([
      at('2026-10-25T00:30:00Z'),
      at('2026-10-25T01:30:00Z'),
    ]);
    expect(wallClockOccurrences(wall('2026-04-05T02:30'), 'Australia/Sydney')).toEqual([
      at('2026-04-04T15:30:00Z'),
      at('2026-04-04T16:30:00Z'),
    ]);
    // Lord Howe moves its clocks by half an hour.
    expect(wallClockOccurrences(wall('2026-04-05T01:45'), 'Australia/Lord_Howe')).toEqual([
      at('2026-04-04T14:45:00Z'),
      at('2026-04-04T15:15:00Z'),
    ]);
  });

  it('finds one for an ordinary wall clock and none for one the clocks skip', () => {
    expect(wallClockOccurrences(wall('2026-11-01T03:00'), 'America/Los_Angeles')).toEqual([
      at('2026-11-01T11:00:00Z'),
    ]);
    expect(wallClockOccurrences(wall('2027-03-14T02:30'), 'America/Los_Angeles')).toEqual([]);
    expect(wallClockOccurrences(wall('2026-11-01T01:30'), 'UTC')).toEqual([
      at('2026-11-01T01:30:00Z'),
    ]);
  });
});

describe('eventInstantsFromInputs: a field left as it opened keeps its stored instant', () => {
  const cases: Array<[zone: string, stored: string, shown: string]> = [
    // West of UTC: the second occurrence used to move an hour earlier.
    ['America/Los_Angeles', '2026-11-01T09:30:00+00:00', '2026-11-01T01:30'],
    ['America/Los_Angeles', '2026-11-01T08:30:00+00:00', '2026-11-01T01:30'],
    ['America/New_York', '2026-11-01T06:30:00+00:00', '2026-11-01T01:30'],
    // East of UTC and at UTC+0: the FIRST occurrence used to move an hour later.
    ['Europe/London', '2026-10-25T00:30:00+00:00', '2026-10-25T01:30'],
    ['Australia/Sydney', '2026-04-04T15:30:00+00:00', '2026-04-05T02:30'],
    ['Australia/Lord_Howe', '2026-04-04T14:45:00+00:00', '2026-04-05T01:45'],
    ['Australia/Lord_Howe', '2026-04-04T15:15:00+00:00', '2026-04-05T01:45'],
  ];

  it.each(cases)('%s: %s opens as %s and saves unchanged', (zone, stored, shown) => {
    expect(eventInputFromInstant(stored, zone)).toBe(shown);
    expect(
      eventInstantsFromInputs({ startsAt: shown, endsAt: shown }, zone, {
        startsAt: stored,
        endsAt: stored,
      }),
    ).toEqual({
      startsAt: stored,
      endsAt: stored,
    });
  });

  it('the conversion alone answers one occurrence, which is why the stored instant is kept', () => {
    // Los Angeles answers the first; London the second.
    expect(eventInstantFromInput('2026-11-01T01:30', 'America/Los_Angeles')).toBe(
      '2026-11-01T08:30:00.000Z',
    );
    expect(eventInstantFromInput('2026-10-25T01:30', 'Europe/London')).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('a changed field is read in the zone as before, and a new event has nothing stored', () => {
    const LA = 'America/Los_Angeles';
    expect(
      eventInstantsFromInputs({ startsAt: '2026-11-01T01:45', endsAt: '' }, LA, {
        startsAt: '2026-11-01T09:30:00+00:00',
      }),
    ).toEqual({ startsAt: '2026-11-01T08:45:00.000Z', endsAt: null });
    expect(
      eventInstantsFromInputs({ startsAt: '2026-11-07T09:00', endsAt: '2026-11-07T10:00' }, LA),
    ).toEqual({
      startsAt: '2026-11-07T17:00:00.000Z',
      endsAt: '2026-11-07T18:00:00.000Z',
    });
  });

  it('a changed time next to an unchanged one in the same repeated hour takes its occurrence, in either direction', () => {
    // Los Angeles, unchanged start at the second 1:30 (PST): a changed end at
    // 1:55 is the second 1:55 too.
    expect(
      eventInstantsFromInputs(
        { startsAt: '2026-11-01T01:30', endsAt: '2026-11-01T01:55' },
        'America/Los_Angeles',
        {
          startsAt: '2026-11-01T09:30:00+00:00',
          endsAt: '2026-11-01T09:50:00+00:00',
        },
      ),
    ).toEqual({ startsAt: '2026-11-01T09:30:00+00:00', endsAt: '2026-11-01T09:55:00.000Z' });
    // London, unchanged end at the first 1:50 (BST): a changed start at 1:20 is
    // the first 1:20, where London alone answers the second.
    expect(
      eventInstantsFromInputs(
        { startsAt: '2026-10-25T01:20', endsAt: '2026-10-25T01:50' },
        'Europe/London',
        {
          startsAt: '2026-10-25T00:30:00+00:00',
          endsAt: '2026-10-25T00:50:00+00:00',
        },
      ),
    ).toEqual({ startsAt: '2026-10-25T00:20:00.000Z', endsAt: '2026-10-25T00:50:00+00:00' });
  });

  it('an unchanged time outside that repeated hour changes nothing about how the other is read', () => {
    const LA = 'America/Los_Angeles';
    // The kept end is at 3:00 AM PST, after the repeated hour: the changed
    // start reads as a new time always did (the first 1:30, PDT).
    expect(
      eventInstantsFromInputs({ startsAt: '2026-11-01T01:30', endsAt: '2026-11-01T03:00' }, LA, {
        startsAt: '2026-11-01T07:00:00+00:00',
        endsAt: '2026-11-01T11:00:00+00:00',
      }),
    ).toEqual({ startsAt: '2026-11-01T08:30:00.000Z', endsAt: '2026-11-01T11:00:00+00:00' });
    // A kept time in another year's repeated hour is another hour.
    expect(eventInstantFromInput('2027-11-07T01:30', LA, '2026-11-01T09:30:00+00:00')).toBe(
      '2027-11-07T08:30:00.000Z',
    );
  });

  it('a blank field or a time the clocks skip is null, kept or not; seconds typed are kept', () => {
    const LA = 'America/Los_Angeles';
    expect(
      eventInstantsFromInputs({ startsAt: '', endsAt: '' }, LA, {
        startsAt: '2026-11-01T09:30:00+00:00',
      }),
    ).toEqual({ startsAt: null, endsAt: null });
    expect(
      eventInstantsFromInputs({ startsAt: '2027-03-14T02:30', endsAt: '2027-03-14T02:45' }, LA),
    ).toEqual({
      startsAt: null,
      endsAt: null,
    });
    expect(eventInstantsFromInputs({ startsAt: '2026-11-07T20:00:30', endsAt: '' }, LA)).toEqual({
      startsAt: '2026-11-08T04:00:30.000Z',
      endsAt: null,
    });
    // A stored value that is not an instant opens blank, so it is never kept.
    expect(eventInputFromInstant('not a date', LA)).toBe('');
  });
});
