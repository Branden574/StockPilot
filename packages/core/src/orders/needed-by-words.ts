/**
 * The needed-by words the New order page shares with the needed-by revision
 * (needed-by-revision.ts) and the order submission (place-order.ts): the
 * label in the organization's zone, the zone note under the field, and the
 * two refusals both the placement and a revision say.
 *
 * Its own module on purpose (review round 1): web chunks include whole
 * modules, so the storefront importing these from needed-by-revision.ts
 * shipped the revision dialog's words on every New order page (2.4 kB raw,
 * 0.9 kB gzip, measured on the production build). Keep this module small:
 * nothing here is only the dialog's.
 */

import { formatOrgDateTime, resolveOrgTimezone } from '../time/org-timezone';
import { zonedParts } from '../time/zoned-wall-clock';

/** A needed-by later than this many years from now is refused
 *  (needed_by_out_of_range): no screen needs one, and the far end of a
 *  timestamp (infinity, year 290000) is past what JavaScript's Date holds. */
export const NEEDED_BY_MAX_YEARS_AHEAD = 5;

/**
 * A needed-by as the screens print it, in the org's zone: "Fri, Oct 3, 2:00
 * PM", with the year when it is not the current year there ("Fri, Jan 8,
 * 2027, 9:00 AM").
 */
export function neededByLabel(
  at: string | number | Date,
  timeZone: string,
  now: number | Date = Date.now(),
): string {
  const zone = resolveOrgTimezone(timeZone);
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '—';
  const sameYear = zonedParts(t, zone).year === zonedParts(now, zone).year;
  return formatOrgDateTime(
    t,
    {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' as const }),
      hour: 'numeric',
      minute: '2-digit',
    },
    zone,
  );
}

/** Under the date field: "Times are in America/Los_Angeles." */
export function neededByZoneNote(timeZone: string): string {
  return `Times are in ${resolveOrgTimezone(timeZone)}.`;
}

export const NEEDED_BY_IN_PAST_COPY = 'Pick a needed-by date and time that is still to come.';
export const NEEDED_BY_OUT_OF_RANGE_COPY = `Pick a needed-by date within the next ${NEEDED_BY_MAX_YEARS_AHEAD} years.`;
