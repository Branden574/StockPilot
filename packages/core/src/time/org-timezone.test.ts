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
