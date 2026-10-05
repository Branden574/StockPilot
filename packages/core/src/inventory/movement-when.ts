/**
 * WHEN A STOCK MOVEMENT HAPPENED, as every surface prints it: the web
 * Movements page, the item history dialog and the item page's Movements and
 * Activity tabs; the phone's Movements list, its item history sheet, its item
 * screen's MOVEMENTS and ACTIVITY cards and its home screen's recent
 * movements.
 *
 * IN THE ORGANIZATION'S TIME ZONE (owner decision Q1, 2026-10-05; L7). These
 * times used to print in the VIEWER's zone (web <LocalDateTime>, the phone's
 * toLocaleString), while counts, exceptions and orders print in the org's. So
 * a movement near midnight showed one day on the Movements page and another on
 * the count card beside it, and a phone set to another zone showed a third.
 * Only visible when the zones differ, which is exactly when it misleads.
 *
 * One shape, the one the viewer-zone text already had ("Jul 15, 2026,
 * 10:28 PM"), so only the zone changes. formatOrgDateTime spells it the same
 * on every engine (plain spaces, the web's separator); an unusable or missing
 * zone degrades to core's documented default (resolveOrgTimezone), never
 * throws out of a render.
 */
import {
  formatOrgDate,
  formatOrgDateTime,
  formatOrgTime,
  ORG_TIMEZONE_DEFAULT,
  plainSpaces,
} from '../time/org-timezone';

export const MOVEMENT_WHEN_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function parse(input: string): Date | null {
  if (typeof input !== 'string' || input.trim() === '') return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "Oct 4, 2026, 10:30 PM" in the organization's zone, or null when `iso` is
 * not a date (the caller then renders nothing, never "Invalid Date").
 * `timeZone` is the raw `organizations.timezone` read; null or undefined (the
 * read failed or has not arrived) uses the documented default.
 */
export function formatMovementWhen(iso: string, timeZone: string | null | undefined): string | null {
  const d = parse(iso);
  if (!d) return null;
  return formatOrgDateTime(d, MOVEMENT_WHEN_OPTIONS, timeZone ?? ORG_TIMEZONE_DEFAULT);
}

/** The compact day ("Oct 4") the phone's Movements list prints, in the
 *  organization's zone, or null when `iso` is not a date. */
export function formatMovementDay(iso: string, timeZone: string | null | undefined): string | null {
  const d = parse(iso);
  if (!d) return null;
  return plainSpaces(formatOrgDate(d, { month: 'short', day: 'numeric' }, timeZone ?? ORG_TIMEZONE_DEFAULT));
}

/** The phone item screen's MOVEMENTS and ACTIVITY cards: the shape their
 *  device-zone text had ("Oct 4, 10:30 PM", no year). */
export const MOVEMENT_CARD_WHEN_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * "Oct 4, 10:30 PM" in the organization's zone, for the phone item screen's
 * movement and audit cards (slice 3 review F2: they printed the device's zone
 * while the Movements list beside them printed the org's), or null when `iso`
 * is not a date.
 */
export function formatMovementCardWhen(iso: string, timeZone: string | null | undefined): string | null {
  const d = parse(iso);
  if (!d) return null;
  return formatOrgDateTime(d, MOVEMENT_CARD_WHEN_OPTIONS, timeZone ?? ORG_TIMEZONE_DEFAULT);
}

/**
 * The 24-hour time ("22:30") in the organization's zone, for the phone home
 * screen's recent movements (slice 3 review F2; the shape their device-zone
 * text had), or null when `iso` is not a date.
 */
export function formatMovementClock(iso: string, timeZone: string | null | undefined): string | null {
  const d = parse(iso);
  if (!d) return null;
  return plainSpaces(
    formatOrgTime(d, { hour: '2-digit', minute: '2-digit', hour12: false }, timeZone ?? ORG_TIMEZONE_DEFAULT),
  );
}
