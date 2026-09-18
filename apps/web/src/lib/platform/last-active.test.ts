import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// Every date here must come out in UTC whatever the server's zone. CI runs in
// UTC, where a local getter and a UTC getter agree and a `getDate()` regression
// would pass unnoticed, so the zone is pinned to one where they differ.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('resolveLastActive', () => {
  it('picks the LATEST of the three and names where it came from', () => {
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-18T09:00:00Z',
        lastActionAt: '2026-09-17T23:30:00Z',
      }),
    ).toEqual({ at: '2026-09-18T09:00:00.000Z', source: 'session', floor: false });

    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-10T09:00:00Z',
        lastActionAt: '2026-09-17T23:30:00Z',
      }),
    ).toEqual({ at: '2026-09-17T23:30:00.000Z', source: 'action', floor: false });

    expect(
      resolveLastActive({
        lastSignInAt: '2026-09-18T08:00:00Z',
        lastSessionAt: null,
        lastActionAt: '2026-09-01T00:00:00Z',
      }),
    ).toEqual({ at: '2026-09-18T08:00:00.000Z', source: 'sign_in', floor: true });
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
    ).toEqual({ at: '2026-09-18T06:00:00.000Z', source: 'session', floor: false });
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
      floor: false,
    });
    expect(resolveLastActive({})).toEqual({ at: null, source: 'never', floor: false });
    expect(
      resolveLastActive({
        lastSignInAt: 'not-a-date',
        lastSessionAt: '',
        lastActionAt: '2026-09-01T00:00:00Z',
      }),
    ).toEqual({ at: '2026-09-01T00:00:00.000Z', source: 'action', floor: true });
  });
});

describe('resolveLastActive — is the value measured, or only a floor?', () => {
  it('is measured while an open sign-in stands behind it, whichever signal won', () => {
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-18T09:00:00Z',
        lastActionAt: null,
      }).floor,
    ).toBe(false);
    // An action newer than the last hourly renewal: the session is still open.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: '2026-09-18T09:00:00Z',
        lastActionAt: '2026-09-18T09:40:00Z',
      }),
    ).toMatchObject({ source: 'action', floor: false });
  });

  it('is a floor when NO session survives, even though an action won', () => {
    // The case a source-keyed hedge misses: signed in 22 Jul, read daily, then
    // signed out or was disabled. The newest evidence is an old audit row, and
    // presenting it as activity would read as eight weeks of absence.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: null,
        lastActionAt: '2026-07-22T15:00:00Z',
      }),
    ).toEqual({ at: '2026-07-22T15:00:00.000Z', source: 'action', floor: true });
  });

  it('is a floor when a sign-in won, even if an OLDER session on another device survives', () => {
    // Phone session last renewed 1 Sep; web sign-in on 12 Sep, read, signed out.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-09-12T15:00:00Z',
        lastSessionAt: '2026-09-01T00:00:00Z',
        lastActionAt: null,
      }),
    ).toEqual({ at: '2026-09-12T15:00:00.000Z', source: 'sign_in', floor: true });
  });

  it('treats an unparseable session as no session', () => {
    expect(
      resolveLastActive({ lastSessionAt: 'not-a-date', lastActionAt: '2026-09-01T00:00:00Z' })
        .floor,
    ).toBe(true);
  });
});

describe('resolveLastActive — the app reporting on itself (migration 0352)', () => {
  it('a seen stamp is MEASURED even when no session survives: that is the case it exists for', () => {
    // Signed in on 22 Jul, read daily, signed out on 17 Sep. Before 0352 the
    // only thing left was the 22 Jul sign-in, shown hedged.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-07-22T08:00:00Z',
        lastSessionAt: null,
        lastActionAt: null,
        lastSeenAt: '2026-09-17T16:55:00Z',
      }),
    ).toEqual({ at: '2026-09-17T16:55:00.000Z', source: 'seen', floor: false });
  });

  it('vouches for an action that follows it closely, and not for one that does not', () => {
    // Stamp at 09:00, action at 09:03, signed out at 09:04: the beacon was live
    // for them, so had they carried on it would have fired again.
    expect(
      resolveLastActive({
        lastSessionAt: null,
        lastActionAt: '2026-09-18T09:03:00Z',
        lastSeenAt: '2026-09-18T09:00:00Z',
      }),
    ).toMatchObject({ source: 'action', floor: false });
    // Exactly ten minutes still vouches; a second more does not.
    expect(
      resolveLastActive({
        lastActionAt: '2026-09-18T09:10:00Z',
        lastSeenAt: '2026-09-18T09:00:00Z',
      }).floor,
    ).toBe(false);
    expect(
      resolveLastActive({
        lastActionAt: '2026-09-18T09:10:01Z',
        lastSeenAt: '2026-09-18T09:00:00Z',
      }).floor,
    ).toBe(true);
  });

  it('cannot rescue a sign-in that no stamp followed', () => {
    // An old stamp, then a fresh sign-in from a client with no beacon (a mobile
    // build that predates it): the sign-in is still only a floor.
    expect(
      resolveLastActive({
        lastSignInAt: '2026-09-18T08:00:00Z',
        lastSeenAt: '2026-09-10T08:00:00Z',
      }),
    ).toMatchObject({ source: 'sign_in', floor: true });
  });

  it('ties: an action beats a stamp, a stamp beats a session', () => {
    expect(
      resolveLastActive({
        lastActionAt: '2026-09-18T09:00:00Z',
        lastSeenAt: '2026-09-18T09:00:00Z',
      }).source,
    ).toBe('action');
    expect(
      resolveLastActive({
        lastSessionAt: '2026-09-18T09:00:00Z',
        lastSeenAt: '2026-09-18T09:00:00Z',
      }).source,
    ).toBe('seen');
  });

  it('ignores a stamp it cannot parse', () => {
    expect(
      resolveLastActive({ lastSeenAt: 'not-a-date', lastSignInAt: '2026-09-01T00:00:00Z' }),
    ).toEqual({ at: '2026-09-01T00:00:00.000Z', source: 'sign_in', floor: true });
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
  const measured = {
    lastSignInAt: '2026-07-22T08:00:00Z',
    lastSessionAt: '2026-09-18T09:00:00Z',
    lastActionAt: '2026-09-17T23:30:00Z',
  };
  const HEDGE = 'may have kept using the product after it';

  it('lists every known signal with its exact instant, so the winner can be checked', () => {
    expect(describeLastActive(measured)).toBe(
      'Sign-in last renewed 18 Sep 2026, 09:00 UTC (any device, any organization; accurate to about an hour). ' +
        'Last recorded action in this organization 17 Sep 2026, 23:30 UTC. ' +
        'Last signed in 22 Jul 2026, 08:00 UTC.',
    );
  });

  it('does NOT hedge a measured value', () => {
    expect(describeLastActive(measured)).not.toContain(HEDGE);
  });

  it('hedges a bare sign-in, because that is when the number is most likely stale', () => {
    const text = describeLastActive({
      lastSignInAt: '2026-08-12T15:00:00Z',
      lastSessionAt: null,
      lastActionAt: null,
    });
    expect(text).toBe(
      'No open sign-ins on any device. Last signed in 12 Aug 2026, 15:00 UTC. ' +
        'The sign-in behind this value is no longer open, so they may have kept using the product after it.',
    );
  });

  it('hedges an ACTION with no session behind it just the same', () => {
    const text = describeLastActive({
      lastSignInAt: '2026-07-22T08:00:00Z',
      lastSessionAt: null,
      lastActionAt: '2026-07-22T15:00:00Z',
    });
    expect(text).toContain('No open sign-ins on any device.');
    expect(text).toContain('Last recorded action in this organization 22 Jul 2026, 15:00 UTC.');
    expect(text).toContain(HEDGE);
  });

  it('does not claim "no open sign-ins" when an older session survives a newer sign-in', () => {
    const text = describeLastActive({
      lastSignInAt: '2026-09-12T15:00:00Z',
      lastSessionAt: '2026-09-01T00:00:00Z',
      lastActionAt: null,
    });
    expect(text).toContain('Sign-in last renewed 1 Sep 2026, 00:00 UTC');
    expect(text).not.toContain('No open sign-ins');
    expect(text).toContain(HEDGE);
  });

  it('names the stamp as what it is: the app open in THIS organization', () => {
    const text = describeLastActive({
      lastSignInAt: '2026-07-22T08:00:00Z',
      lastSessionAt: null,
      lastSeenAt: '2026-09-17T16:55:00Z',
    });
    expect(text).toBe(
      'No open sign-ins on any device. ' +
        'Last had StockPilot open in this organization 17 Sep 2026, 16:55 UTC. ' +
        'Last signed in 22 Jul 2026, 08:00 UTC.',
    );
  });

  it('never says "signed out": a disable or a password change ends a sign-in too', () => {
    expect(
      describeLastActive({
        lastSignInAt: '2026-08-12T15:00:00Z',
        lastSessionAt: null,
        lastActionAt: null,
      }),
    ).not.toMatch(/signed out/i);
  });

  it('explains never', () => {
    expect(
      describeLastActive({ lastSignInAt: null, lastSessionAt: null, lastActionAt: null }),
    ).toBe('This person has never signed in and has no recorded activity in this organization.');
  });
});
