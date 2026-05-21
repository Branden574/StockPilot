/**
 * Org timezone helper.
 *
 * The app stores all timestamps as UTC in Postgres (timestamptz).
 * When rendering for staff users we need to pin the locale-aware
 * formatters to the org's operational timezone so a user in
 * California sees PT, not whatever the serverless container picked.
 * Without a `timeZone` option Node/Edge defaults to UTC (Vercel) or
 * the user's browser tz (client) — neither is acceptable for
 * staff-facing schedule / detail pages where 10am PT was getting
 * rendered as "5pm UTC".
 *
 * Single source of truth — the PDF code path uses the same default
 * (see lib/pdf/styles.ts). When per-org timezones ship as a settings
 * column, swap this default for a runtime lookup and every consumer
 * picks it up automatically.
 */
export const ORG_TIMEZONE = 'America/Los_Angeles';

/** Locale-aware date formatter pinned to the org timezone. */
export function formatOrgDate(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { timeZone: ORG_TIMEZONE, ...opts });
}

/** Locale-aware time formatter pinned to the org timezone. */
export function formatOrgTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { timeZone: ORG_TIMEZONE, ...opts });
}

/** Combined date + time, locale-aware, pinned to the org timezone. */
export function formatOrgDateTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: ORG_TIMEZONE, ...opts });
}
