import { resolveOrgTimezone, zonedParts } from '@stockpilot/core';

/**
 * Dates on the platform console.
 *
 * Every console page is a server component, so a bare toLocaleDateString()
 * printed the SERVER's calendar day (UTC on Vercel) and named no zone: an
 * organization created at 6:30 PM Pacific on 24 Oct was listed as created
 * "10/25/2026". So a date that belongs to one organization (when it was
 * created, when a member joined or was disabled, when an order was placed, a
 * member's last activity more than a month back) is printed in THAT
 * organization's zone, the zone its own pages use, and a time also names the
 * zone. An instant that belongs to no organization (the platform audit trail)
 * is printed in UTC and says so (formatExactUtc in ./last-active.ts).
 *
 * The console's own spelling, "24 Oct 2026", as the Users tab has always
 * printed its dates. The zone is a parameter, so the words are the same on
 * every server. A missing or unrecognised zone falls back to the documented
 * default (resolveOrgTimezone) and never throws: these render on the only
 * surface that can disable an account, which has no error boundary.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Instant = string | number | Date | null | undefined;

/** Epoch millis for an instant, or null for anything that is not one. */
function toMillis(input: Instant): number | null {
  if (input === null || input === undefined || input === '') return null;
  const ms =
    input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * "24 Oct 2026": the calendar day the instant falls on in `timeZone` (an
 * organization's stored zone, or 'UTC'). "—" when there is no instant.
 */
export function formatDayInZone(input: Instant, timeZone: string | null | undefined): string {
  const ms = toMillis(input);
  if (ms === null) return '—';
  const p = zonedParts(ms, resolveOrgTimezone(timeZone));
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/**
 * "24 Oct 2026, 18:30 PDT": the wall clock in `timeZone`, with the zone's
 * short name (a GMT offset where the zone has none in English). "—" when
 * there is no instant.
 */
export function formatMomentInZone(input: Instant, timeZone: string | null | undefined): string {
  const ms = toMillis(input);
  if (ms === null) return '—';
  const zone = resolveOrgTimezone(timeZone);
  const p = zonedParts(ms, zone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${hh}:${mm} ${zoneName(ms, zone)}`;
}

/** The zone's short name at that instant ("PDT", "PST", "UTC"), or the zone id. */
function zoneName(ms: number, zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((x) => x.type === 'timeZoneName');
    if (part?.value) return part.value;
  } catch {
    // An engine without zone names: the zone id still says which zone it is.
  }
  return zone;
}
