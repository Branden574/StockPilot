/**
 * A CALENDAR DATE kept in a timestamptz: the day a person picked, stored as
 * that day's midnight UTC. A purchase order's expected date is one. Every
 * writer stores it that way: the web PO form's <input type="date"> through
 * `new Date('YYYY-MM-DD').toISOString()` (ECMAScript reads a bare date as
 * UTC), both PO imports, and the phone's normalizeExpectedAt
 * (`YYYY-MM-DDT00:00:00.000Z`). Production 2026-10-06: 34 purchase orders have
 * one, every one at 00:00 UTC.
 *
 * So the day is read back in UTC. In any zone west of UTC (every US zone) the
 * same instant is still the evening of the day BEFORE: the phone's Purchase
 * orders and Receive POs screens printed it in the device's zone and showed
 * "Oct 9" for a purchase order expected Oct 10. The organization's zone would
 * be as wrong; this is a day, not an instant to move into a zone. The PO PDF
 * (apps/web lib/pdf/po.tsx) reads it the same way.
 *
 * ONE RULE FOR EVERY SURFACE: the phone's two PO screens, the order readiness
 * lines (readiness-copy.ts), the web PO list and PO page, and the weekly
 * digest all print an expected date through this, so they name the same day
 * whatever zone they run in (a phone, a browser, a server).
 *
 * Never for an instant (created_at, received_at, a needed-by time): those
 * print in the organization's zone (./org-timezone.ts).
 *
 * PLATFORM NOTE. A date-only Intl.DateTimeFormat in UTC. Every field of a
 * date-only format is typed on the phone's Hermes too (zoned-wall-clock.ts),
 * and the words match the web's; the tests run it through the Hermes
 * stand-in.
 */

/** "Oct 10": what the phone's PO screens, the PO list and the readiness lines print. */
export const CALENDAR_DATE_SHORT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/**
 * The stored day, in en-US words ("Oct 10" by default). `opts` takes date
 * fields only (year, month, day, weekday); the zone is always UTC, whatever
 * `opts` says. A dash for a missing or unreadable date.
 */
export function formatCalendarDate(
  value: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = CALENDAR_DATE_SHORT,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  // The zone goes last, so no option can move the day.
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' })
    .format(d)
    .replace(/[  ]/g, ' ');
}
