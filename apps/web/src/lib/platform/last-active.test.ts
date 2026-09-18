import { describe, expect, it } from 'vitest';

import {
  describeLastActive,
  formatExactUtc,
  formatLastActive,
  resolveLastActive,
} from './last-active';

/**
 * The Users tab of the platform console shows ONE "Last active" value built
 * from three timestamps that each lie in a different direction. An operator
 * may read this number when deciding that an account is dormant, so the two
 * failures worth pinning are: picking the wrong one of the three, and
 * presenting a fallback as if it were a measurement.
 */

const NOW = new Date('2026-09-18T12:00:00Z');

describe('resolveLastActive', () => {
  it('picks the LATEST of the three and names where it came from', () => {
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-18T09:00:00Z',
        lastActionAt: '2026-09-17T23:30:00Z',
      }),
    ).toEqual({ at: '2026-09-18T09:00:00.000Z', source: 'session' });

    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-10T09:00:00Z',
        lastActionAt: '2026-09-17T23:30:00Z',
      }),
    ).toEqual({ at: '2026-09-17T23:30:00.000Z', source: 'action' });

    expect(
      resolveLastActive({
        lastSignInAt: '2026-09-18T08:00:00Z',
        lastSessionAt: null,
        lastActionAt: '2026-09-01T00:00:00Z',
      }),
    ).toEqual({ at: '2026-09-18T08:00:00.000Z', source: 'sign_in' });
  });

  it('compares INSTANTS, not strings', () => {
    // Lexicographically '2026-09-17T23…' sorts before '2026-09-18T01…', but
    // 23:00 at -07:00 is 06:00Z on the 18th: five hours LATER than 01:00Z.
    expect(
      resolveLastActive({
        lastSignInAt: null,
        lastSessionAt: '2026-09-17T23:00:00-07:00',
        lastActionAt: '2026-09-18T01:00:00+00:00',
      }),
    ).toEqual({ at: '2026-09-18T06:00:00.000Z', source: 'session' });
  });

  it('prefers the more specific source on an exact tie', () => {
    // A sign-in creates its session in the same instant. "Signed in" is the
    // fallback wording, so it must lose a tie it does not need to win.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-09-18T08:00:00Z',
        lastSessionAt: '2026-09-18T08:00:00Z',
        lastActionAt: null,
      }).source,
    ).toBe('session');
    expect(
      resolveLastActive({
        lastSignInAt: null,
        lastSessionAt: '2026-09-18T08:00:00Z',
        lastActionAt: '2026-09-18T08:00:00Z',
      }).source,
    ).toBe('action');
  });

  it('reports never when nothing is known, and ignores values it cannot parse', () => {
    expect(
      resolveLastActive({ lastSignInAt: null, lastSessionAt: null, lastActionAt: null }),
    ).toEqual({
      at: null,
      source: 'never',
    });
    expect(resolveLastActive({})).toEqual({ at: null, source: 'never' });
    expect(
      resolveLastActive({
        lastSignInAt: 'not-a-date',
        lastSessionAt: '',
        lastActionAt: '2026-09-01T00:00:00Z',
      }),
    ).toEqual({ at: '2026-09-01T00:00:00.000Z', source: 'action' });
  });
});

describe('formatLastActive', () => {
  it('is coarse on purpose: the signal has about one hour of resolution', () => {
    expect(formatLastActive('2026-09-18T11:59:30Z', NOW)).toBe('Within the last hour');
    expect(formatLastActive('2026-09-18T11:00:01Z', NOW)).toBe('Within the last hour');
    expect(formatLastActive('2026-09-18T11:00:00Z', NOW)).toBe('1 hour ago');
    expect(formatLastActive('2026-09-18T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(formatLastActive('2026-09-17T12:00:01Z', NOW)).toBe('23 hours ago');
  });

  it('counts whole elapsed days, which needs no time zone', () => {
    expect(formatLastActive('2026-09-17T12:00:00Z', NOW)).toBe('1 day ago');
    expect(formatLastActive('2026-09-15T12:00:00Z', NOW)).toBe('3 days ago');
    expect(formatLastActive('2026-08-19T12:00:01Z', NOW)).toBe('29 days ago');
  });

  it('switches to a UTC calendar date from thirty days on', () => {
    expect(formatLastActive('2026-08-19T12:00:00Z', NOW)).toBe('19 Aug 2026');
    expect(formatLastActive('2026-05-28T23:30:00-07:00', NOW)).toBe('29 May 2026');
  });

  it('never throws and never invents a time', () => {
    expect(formatLastActive(null, NOW)).toBe('Never');
    expect(formatLastActive(undefined, NOW)).toBe('Never');
    expect(formatLastActive('', NOW)).toBe('Never');
    expect(formatLastActive('not-a-date', NOW)).toBe('Never');
  });

  it('treats a clock-skewed future instant as just now, not as a negative age', () => {
    expect(formatLastActive('2026-09-18T12:00:20Z', NOW)).toBe('Within the last hour');
  });
});

describe('formatExactUtc', () => {
  it('prints a labelled UTC instant that reads the same on every server', () => {
    expect(formatExactUtc('2026-09-18T09:05:59Z')).toBe('18 Sep 2026, 09:05 UTC');
    expect(formatExactUtc('2026-09-17T23:30:00-07:00')).toBe('18 Sep 2026, 06:30 UTC');
  });

  it('returns null for anything that is not an instant', () => {
    expect(formatExactUtc(null)).toBeNull();
    expect(formatExactUtc(undefined)).toBeNull();
    expect(formatExactUtc('nope')).toBeNull();
  });
});

describe('describeLastActive', () => {
  const session = {
    lastSignInAt: '2026-07-22T08:00:00Z',
    lastSessionAt: '2026-09-18T09:00:00Z',
    lastActionAt: '2026-09-17T23:30:00Z',
  };

  it('lists every known signal with its exact instant, so the winner can be checked', () => {
    const text = describeLastActive(session);
    expect(text).toContain('Sign-in last renewed 18 Sep 2026, 09:00 UTC');
    expect(text).toContain('Last recorded action in this organization 17 Sep 2026, 23:30 UTC');
    expect(text).toContain('Last signed in 22 Jul 2026, 08:00 UTC');
  });

  it('says plainly when the value is only a sign-in, because that is when it is most likely stale', () => {
    const text = describeLastActive({
      lastSignInAt: '2026-08-12T15:00:00Z',
      lastSessionAt: null,
      lastActionAt: null,
    });
    expect(text).toContain('No open sign-ins on any device');
    expect(text).toContain('Last signed in 12 Aug 2026, 15:00 UTC');
    expect(text).toContain('may have kept working after this');
  });

  it('explains never', () => {
    expect(
      describeLastActive({ lastSignInAt: null, lastSessionAt: null, lastActionAt: null }),
    ).toBe('This person has never signed in and has no recorded activity in this organization.');
  });
});
