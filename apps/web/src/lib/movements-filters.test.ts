import { describe, expect, it } from 'vitest';

import {
  buildMovementsQueryString,
  parseFromDateParam,
  parseMovementTypeParam,
  parseToDateParam,
} from './movements-filters';

/**
 * SP-079. The Movements date filter used to build its bounds at UTC midnight
 * while every row on screen renders in a local zone (components/ui/
 * local-datetime.tsx). For the Pacific orgs that meant From=To=2026-09-10
 * silently EXCLUDED everything posted after 17:00 PT that day and INCLUDED
 * the previous evening — the CSV export shared the bounds, so a day
 * reconciliation exported the wrong day. These tests pin the zone-aware
 * bounds, the untouched legacy (no-zone) behaviour, and the DST offsets.
 */
describe('parseFromDateParam / parseToDateParam — zone-aware day bounds', () => {
  it('resolves the day boundary in the given zone, not at UTC midnight', () => {
    // Pacific Daylight Time = UTC-7, so the day starts at 07:00Z and the
    // exclusive upper bound is the NEXT day's 07:00Z.
    expect(parseFromDateParam('2026-09-10', 'America/Los_Angeles')).toBe('2026-09-10T07:00:00.000Z');
    expect(parseToDateParam('2026-09-10', 'America/Los_Angeles')).toBe('2026-09-11T07:00:00.000Z');
  });

  it('follows DST — the same zone yields a different offset in January than in July', () => {
    // PDT (UTC-7) in July, PST (UTC-8) in January. A fixed offset would get
    // one of these two wrong for half the year.
    expect(parseFromDateParam('2026-07-10', 'America/Los_Angeles')).toBe('2026-07-10T07:00:00.000Z');
    expect(parseFromDateParam('2026-01-10', 'America/Los_Angeles')).toBe('2026-01-10T08:00:00.000Z');
    expect(parseToDateParam('2026-01-10', 'America/Los_Angeles')).toBe('2026-01-11T08:00:00.000Z');
  });

  it('handles a spring-forward day (02:00 -> 03:00) and an east-of-UTC zone', () => {
    // 2026-03-08 is the US spring-forward day; midnight itself still exists,
    // so the bound is a plain PST midnight and the day is only 23h long.
    expect(parseFromDateParam('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-08T08:00:00.000Z');
    expect(parseToDateParam('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-09T07:00:00.000Z');
    // East of UTC the bound moves the other way.
    expect(parseFromDateParam('2026-09-10', 'Asia/Tokyo')).toBe('2026-09-09T15:00:00.000Z');
    expect(parseToDateParam('2026-09-10', 'Asia/Tokyo')).toBe('2026-09-10T15:00:00.000Z');
  });

  it('keeps the legacy UTC bounds when no zone is passed (and for an explicit UTC)', () => {
    expect(parseFromDateParam('2026-09-10')).toBe('2026-09-10T00:00:00.000Z');
    expect(parseToDateParam('2026-09-10')).toBe('2026-09-11T00:00:00.000Z');
    expect(parseFromDateParam('2026-09-10', 'UTC')).toBe('2026-09-10T00:00:00.000Z');
    expect(parseToDateParam('2026-09-10', 'UTC')).toBe('2026-09-11T00:00:00.000Z');
    // A blank/whitespace zone is "no zone", not a crash.
    expect(parseFromDateParam('2026-09-10', '')).toBe('2026-09-10T00:00:00.000Z');
    expect(parseFromDateParam('2026-09-10', '   ')).toBe('2026-09-10T00:00:00.000Z');
    expect(parseFromDateParam('2026-09-10', null)).toBe('2026-09-10T00:00:00.000Z');
  });

  it('degrades a zone this runtime does not know instead of throwing out of a render', () => {
    // resolveOrgTimezone's contract: an unrecognised stored organizations.
    // timezone must never RangeError inside a render — it falls back to the
    // documented org default (America/Los_Angeles).
    expect(() => parseFromDateParam('2026-09-10', 'America/Fresno')).not.toThrow();
    expect(parseFromDateParam('2026-09-10', 'America/Fresno')).toBe('2026-09-10T07:00:00.000Z');
  });

  it('still ignores garbage dates rather than throwing, with or without a zone', () => {
    expect(parseFromDateParam('not-a-date')).toBeUndefined();
    expect(parseToDateParam('not-a-date', 'America/Los_Angeles')).toBeUndefined();
    expect(parseFromDateParam('')).toBeUndefined();
    expect(parseFromDateParam(undefined)).toBeUndefined();
    expect(parseToDateParam(null, 'America/Los_Angeles')).toBeUndefined();
  });

  it('brackets the reported failure: an 18:30 PT movement falls inside its own PT day', () => {
    // The write-off from the finding: 2026-09-10 18:30 PT = 2026-09-11T01:30Z.
    const posted = Date.parse('2026-09-11T01:30:00.000Z');
    const since = Date.parse(parseFromDateParam('2026-09-10', 'America/Los_Angeles')!);
    const until = Date.parse(parseToDateParam('2026-09-10', 'America/Los_Angeles')!);
    expect(posted).toBeGreaterThanOrEqual(since);
    expect(posted).toBeLessThan(until);
    // ...and the PREVIOUS evening (2026-09-09 19:00 PT) does not.
    const previousEvening = Date.parse('2026-09-10T02:00:00.000Z');
    expect(previousEvening).toBeLessThan(since);
  });
});

describe('parseMovementTypeParam / buildMovementsQueryString (unchanged behaviour)', () => {
  it('accepts real movement types and drops everything else', () => {
    expect(parseMovementTypeParam('receive_po')).toBe('receive_po');
    expect(parseMovementTypeParam('all')).toBeUndefined();
    expect(parseMovementTypeParam('')).toBeUndefined();
    expect(parseMovementTypeParam(undefined)).toBeUndefined();
  });

  it('omits empty fields and trims q', () => {
    expect(buildMovementsQueryString({ q: '  bolt ', type: 'add', from: '2026-09-01', to: '' })).toBe(
      'q=bolt&type=add&from=2026-09-01',
    );
    expect(buildMovementsQueryString({ q: '   ', type: '', from: '', to: '' })).toBe('');
  });
});
