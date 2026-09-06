import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as appConstants from './app';

/**
 * Revert-proof for SP-121.
 *
 * `app.ts` used to export three addresses on `stockpilot.app` — APP_DOMAIN,
 * SUPPORT_EMAIL and FROM_EMAIL_DEFAULT ('StockPilot <hello@stockpilot.app>').
 * NOTHING imported them (verified by `grep -rnw` across apps — mobile
 * included — packages, scripts, docs and supabase), while the addresses the
 * product actually sends from and publishes live on `stockpilotusa.com`:
 *   - apps/web/src/lib/env.ts  RESEND_FROM_EMAIL default
 *                              'StockPilot <hello@stockpilotusa.com>'
 *   - apps/web/src/lib/site.ts SUPPORT_EMAIL / PRIVACY_EMAIL / SITE_URL
 *
 * Because `constants/index.ts` does `export * from './app'`, those stale
 * values were part of the public `@stockpilot/core` surface: the next person
 * wiring a sender would have found FROM_EMAIL_DEFAULT by autocomplete and
 * shipped mail From: a domain with no DKIM/SPF record — silent spam-foldering,
 * not a build error. They were deleted rather than corrected, because a second
 * copy of the sending identity is exactly how the drift happened.
 *
 * This test outlives the deletion on purpose: it fails the moment anyone
 * re-adds an address here, on the dead domain or not.
 */
const DEAD_DOMAIN = 'stockpilot.app';
const LIVE_DOMAIN = 'stockpilotusa.com';

const SOURCE = readFileSync(fileURLToPath(new URL('./app.ts', import.meta.url)), 'utf8');

/**
 * Code with comments stripped. The file's doc comment names the dead domain on
 * purpose (that is the incident record, and rule: never delete a WHY comment),
 * so the source scan below has to look at code only.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** An email address or a bare hostname — the shapes that can carry a domain. */
function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  return /[^\s<>]+@[^\s<>]+\.[a-z]{2,}/i.test(trimmed) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed);
}

describe('packages/core app constants', () => {
  it('detects address-shaped values (proves the domain guard below is live)', () => {
    // Without this, the guard could pass by matching nothing at all.
    expect(looksLikeAddress('StockPilot <hello@stockpilot.app>')).toBe(true);
    expect(looksLikeAddress('support@stockpilot.app')).toBe(true);
    expect(looksLikeAddress('stockpilot.app')).toBe(true);
    expect(looksLikeAddress('StockPilot')).toBe(false);
    expect(looksLikeAddress(appConstants.APP_DESCRIPTION)).toBe(false);
  });

  it('exports no value carrying an address on the dead stockpilot.app domain', () => {
    const offenders = Object.entries(appConstants)
      .filter(([, value]) => typeof value === 'string' && value.includes(DEAD_DOMAIN))
      .map(([name, value]) => `${name} = ${String(value)}`);

    expect(offenders).toEqual([]);
  });

  it('names stockpilot.app nowhere in its CODE (private consts included)', () => {
    // A source scan, not just an export scan: a stale value parked in a
    // non-exported const is the same trap for the next reader.
    expect(CODE.includes(DEAD_DOMAIN)).toBe(false);
  });

  it('does not re-introduce the deleted sending/support identity', () => {
    // These three names are reserved dead. The sending identity lives in
    // apps/web/src/lib/env.ts (RESEND_FROM_EMAIL) and the published support
    // and site addresses in apps/web/src/lib/site.ts — one definition each.
    for (const name of ['APP_DOMAIN', 'SUPPORT_EMAIL', 'FROM_EMAIL_DEFAULT']) {
      expect(Object.keys(appConstants)).not.toContain(name);
    }
  });

  it('requires any address it ever gains to be on the live domain', () => {
    // Guards the "corrected in place" outcome too: if a future change keeps an
    // address here instead of deleting it, it has to be the live domain.
    // `as unknown[]` because Object.values() narrows these `as const` exports
    // to a literal union, which a `value is string` predicate cannot widen.
    const addresses = (Object.values(appConstants) as unknown[]).filter(
      (value): value is string => typeof value === 'string' && looksLikeAddress(value),
    );
    for (const address of addresses) {
      expect(address).toContain(LIVE_DOMAIN);
    }
  });

  it('keeps the constants that real consumers import', () => {
    // apps/web/src/app/layout.tsx imports both for the site <title>/description.
    expect(appConstants.APP_NAME).toBe('StockPilot');
    expect(typeof appConstants.APP_DESCRIPTION).toBe('string');
    expect(appConstants.APP_DESCRIPTION.length).toBeGreaterThan(0);
  });
});
