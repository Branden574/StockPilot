import { describe, expect, it } from 'vitest';

import {
  ORG_TIMEZONE_DEFAULT,
  formatOrgDateTime,
  resolveOrgTimezone,
} from './org-timezone';

/**
 * `resolveOrgTimezone` — the ONE answer to "what zone do we print when the
 * org's zone did not arrive".
 *
 * It exists because there were two answers. Web's `getCachedOrgTimezone`
 * returned a hardcoded 'UTC'; mobile's delivery-request mapping used
 * ORG_TIMEZONE_DEFAULT. One order therefore stated two different needed-by
 * times in mail to the same warehouse. These tests pin the rule and, more
 * importantly, pin the CONSEQUENCE the divergence had — the calendar-day flip —
 * so that a future change to the default has to look at what it costs.
 */
describe('resolveOrgTimezone', () => {
  it('returns a real stored zone untouched — including a deliberately-stored UTC', () => {
    // organizations.timezone is NOT NULL DEFAULT 'UTC', so 'UTC' is a value an
    // org genuinely holds, never a signal that the setting is unset. Resolving
    // it to Pacific would silently relabel every such org's times.
    expect(resolveOrgTimezone('UTC')).toBe('UTC');
    expect(resolveOrgTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveOrgTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it('falls back to the documented default for every shape of "did not arrive"', () => {
    expect(resolveOrgTimezone(null)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(undefined)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('')).toBe(ORG_TIMEZONE_DEFAULT);
  });

  it('treats whitespace as absent, because a blank zone makes Intl THROW rather than degrade', () => {
    expect(resolveOrgTimezone('   ')).toBe(ORG_TIMEZONE_DEFAULT);
    // The failure this prevents, demonstrated rather than asserted from memory.
    expect(() => new Date(0).toLocaleString('en-US', { timeZone: '   ' })).toThrow(RangeError);
    expect(() => formatOrgDateTime(0, {}, resolveOrgTimezone('   '))).not.toThrow();
  });

  it('the default is Pacific, not UTC — and never returns null or an empty string', () => {
    expect(ORG_TIMEZONE_DEFAULT).toBe('America/Los_Angeles');
    for (const raw of [null, undefined, '', '  ']) {
      const resolved = resolveOrgTimezone(raw);
      expect(resolved).toBe('America/Los_Angeles');
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it('THE COST OF DISAGREEING: the two old defaults name a different CALENDAR DAY, not just a different clock', () => {
    // A needed-by of 6pm Pacific on Aug 18. The order is the same; only the
    // zone the surface picked differs.
    const instant = new Date('2026-08-19T01:00:00.000Z');
    const pacific = formatOrgDateTime(instant, { dateStyle: 'medium' }, resolveOrgTimezone(null));
    const utcTheOldWebFallback = formatOrgDateTime(instant, { dateStyle: 'medium' }, 'UTC');

    expect(pacific).toContain('Aug 18');
    expect(utcTheOldWebFallback).toContain('Aug 19');
    expect(pacific).not.toBe(utcTheOldWebFallback);
  });

  it('is idempotent, so a surface that resolves early cannot be re-defaulted into a different zone', () => {
    // The order/new page relies on this: it takes an already-resolved value and
    // must not apply a second `|| ORG_TIMEZONE_DEFAULT` of its own.
    for (const raw of ['UTC', 'America/New_York', '', null]) {
      expect(resolveOrgTimezone(resolveOrgTimezone(raw))).toBe(resolveOrgTimezone(raw));
    }
  });
});

describe('resolveOrgTimezone — a stored zone must never take a screen down', () => {
  it('passes through a zone this runtime recognises', () => {
    expect(resolveOrgTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveOrgTimezone('UTC')).toBe('UTC');
  });

  it('falls back for a zone that does not exist, instead of throwing', () => {
    // 'America/Fresno' is the real shape of this bug: a plausible-looking
    // string a human would type into a settings field. Before this, it threw
    // RangeError out of formatOrgDateTime — and that call sits inside a
    // React.useMemo on the native order screen, so one bad organizations row
    // took the whole screen white rather than mis-formatting one line.
    expect(resolveOrgTimezone('America/Fresno')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('Not/AZone')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(null)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(undefined)).toBe(ORG_TIMEZONE_DEFAULT);
  });

  it('formatOrgDateTime does not throw on any of them', () => {
    for (const tz of ['America/Fresno', 'Not/AZone', '', 'Etc/Nope']) {
      expect(() =>
        formatOrgDateTime('2026-08-18T09:00', { dateStyle: 'medium' }, tz),
      ).not.toThrow();
    }
  });

  it('the fallback formats in the DEFAULT zone, not in the rejected one', () => {
    // Proof the fallback is real arithmetic rather than a swallowed error: the
    // bad-zone result must equal the default-zone result for the same instant.
    const instant = '2026-08-18T16:00:00.000Z';
    const opts = { dateStyle: 'medium', timeStyle: 'short' } as const;
    expect(formatOrgDateTime(instant, opts, 'America/Fresno')).toBe(
      formatOrgDateTime(instant, opts, ORG_TIMEZONE_DEFAULT),
    );
    // ...and is genuinely different from another real zone, so the assertion
    // above is not passing because everything renders the same.
    expect(formatOrgDateTime(instant, opts, 'America/New_York')).not.toBe(
      formatOrgDateTime(instant, opts, ORG_TIMEZONE_DEFAULT),
    );
  });
});
