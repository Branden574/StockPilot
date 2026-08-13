/**
 * Org timezone helper.
 *
 * The app stores all timestamps as UTC in Postgres (timestamptz).
 * When rendering we pin the locale-aware formatters to the org's
 * operational timezone so a workspace in California sees PT, not the
 * serverless container's UTC or the visiting user's browser zone.
 *
 * Source of truth is the `organizations.timezone` column — settable
 * via /dashboard/settings/organization. Server code reads it through
 * `getCachedOrgTimezone(orgId)` (lib/dashboard/cached-org.ts) and
 * passes the string to the `tz` argument on these helpers. Client
 * components that can't async-fetch fall back to ORG_TIMEZONE_DEFAULT.
 *
 * Why LA as the default fallback: this app shipped against a single
 * California-based pilot org before the per-org tz column was wired
 * up. Defaulting to LA preserves the existing behavior for any caller
 * that hasn't been migrated yet, instead of silently flipping to UTC
 * and rendering "yesterday" dates for late-night exports.
 *
 * MOVED HERE 2026-08-13 (from apps/web/src/lib/timezone.ts), whole and
 * unchanged, because the delivery-request builder needs `formatOrgDateTime`
 * and that builder now serves both web and mobile — and mobile's only
 * workspace dependency is `@stockpilot/core`. Moving ONE function and leaving
 * the other three behind would have been recurring pattern #26 (a duplicated
 * function whose copies drift), so the file moved whole.
 *
 * `apps/web/src/lib/timezone.ts` still exists and re-exports these four names,
 * so all five of its web importers — and, critically, the
 * `vi.mock('@/lib/timezone', ...)` in `schedule-calendar.test.tsx` — keep
 * working untouched. Rewriting those imports to `@stockpilot/core` would have
 * silently defeated that mock.
 *
 * PLATFORM NOTE: these are `Intl`/`toLocaleString`, which is ES-standard and
 * present in Hermes. Hermes ships a REDUCED ICU by default, so a React Native
 * consumer that needs full named-timezone support must be built with
 * `jsc-intl`/full-ICU or polyfilled; that is a build concern for the consuming
 * app, not a reason to keep the formatter in web.
 */
export const ORG_TIMEZONE_DEFAULT = 'America/Los_Angeles';

/** Locale-aware date formatter. Pass the org's tz explicitly via
 *  the third argument when available; falls back to the default. */
export function formatOrgDate(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { timeZone: tz, ...opts });
}

/** Locale-aware time formatter. */
export function formatOrgTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { timeZone: tz, ...opts });
}

/** Combined date + time, locale-aware. */
export function formatOrgDateTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: tz, ...opts });
}
