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
 *
 * WHEN A STORED DAY IS PAST (owner rule, 2026-10-06): isPastExpectedDay and
 * pastExpectedDayCutoff below, for "overdue" and "late".
 */
import { resolveOrgTimezone } from './org-timezone';
import { zonedParts } from './zoned-wall-clock';

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

// ── When a stored day is past: "overdue" and "late" ─────────────────────────
//
// THE RULE (owner, 2026-10-06). A purchase order is OVERDUE when the
// organization's current date, in organizations.timezone, is AFTER its
// expected day. A delivery is LATE when it was received on a day, in the
// organization's zone, after the expected day. The expected day itself is
// never overdue and never late.
//
// THE DEFECT THIS CLOSES. Every check compared the stored midnight UTC with an
// instant: the dashboard's and the briefing's overdue count (`expected_at <
// now` in PostgREST), the weekly digest's OVERDUE flag, the phone's Receive
// POs count, and the supplier scorecard's on-time rate (`received_at <=
// expected_at`). West of UTC that midnight is the evening BEFORE, so a
// purchase order expected Oct 10 was overdue from 5 PM Pacific on Oct 9 (4 PM
// in winter), under an ETA of Oct 10; east of UTC it was overdue from late
// morning ON Oct 10; and a delivery received at any time on its expected day
// after that midnight was late.
//
// ONE RULE, TWO SHAPES. isPastExpectedDay is the predicate (the digest, the
// phone and the scorecard call it). pastExpectedDayCutoff is the same rule as
// an instant, for a database filter: the organization's current day at
// midnight UTC. A stored value is before that instant exactly when its UTC day
// is before the organization's current day, whatever its time of day, so
// `expected_at < cutoff` and isPastExpectedDay agree on every value (pinned
// by a sweep in expected-day.test.ts).
//
// Never for a needed-by or any other instant compared with now: those are
// instants on both sides.

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** An instant from what a caller holds; null when there is none or it is unreadable. */
function instantOf(at: Date | string | number | null | undefined): Date | null {
  if (at === null || at === undefined || at === '') return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The stored day of a calendar date, "YYYY-MM-DD", read in UTC as
 * formatCalendarDate reads it. Null for a missing or unreadable value.
 */
export function expectedDayOf(value: string | Date | null | undefined): string | null {
  const d = instantOf(value);
  return d === null ? null : d.toISOString().slice(0, 10);
}

/**
 * The calendar day `at` falls on in the organization's zone, "YYYY-MM-DD".
 * `timeZone` is organizations.timezone as read; unset or unknown to this
 * runtime, it is the documented default (resolveOrgTimezone). Null for an
 * unreadable instant, or when this runtime's Intl cannot name the day.
 */
export function orgDayOf(
  at: Date | string | number | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  const d = instantOf(at);
  if (d === null) return null;
  try {
    const p = zonedParts(d, resolveOrgTimezone(timeZone));
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  } catch {
    return null;
  }
}

/**
 * True when the day `at` falls on, in the organization's zone, is AFTER the
 * stored day `expectedAt`. With `at` the current instant: the purchase order is
 * overdue. With `at` the receipt: the delivery was late. The expected day
 * itself is never past.
 *
 * False when either value is missing or unreadable, or the runtime cannot name
 * the organization's day: nothing is called overdue or late on a guess.
 */
export function isPastExpectedDay(
  expectedAt: string | Date | null | undefined,
  at: Date | string | number | null | undefined,
  timeZone: string | null | undefined,
): boolean {
  return pastExpectedDayTest(at, timeZone)(expectedAt);
}

/**
 * isPastExpectedDay for many purchase orders at one moment: the
 * organization's day is worked out once, and the returned test compares each
 * expected day with it. The same rule (isPastExpectedDay delegates here), for
 * lists that would otherwise work the day out again for every row.
 */
export function pastExpectedDayTest(
  at: Date | string | number | null | undefined,
  timeZone: string | null | undefined,
): (expectedAt: string | Date | null | undefined) => boolean {
  const day = orgDayOf(at, timeZone);
  return (expectedAt) => {
    if (day === null) return false;
    const expectedDay = expectedDayOf(expectedAt);
    return expectedDay !== null && expectedDay < day;
  };
}

/**
 * isPastExpectedDay as an instant a database filter compares with: the
 * organization's current day at midnight UTC ("2026-10-10T00:00:00.000Z").
 * A stored expected date is past exactly when `expected_at < cutoff`. Null when
 * `now` is unreadable or the runtime cannot name the day (count nothing).
 */
export function pastExpectedDayCutoff(
  now: Date | string | number,
  timeZone: string | null | undefined,
): string | null {
  const day = orgDayOf(now, timeZone);
  return day === null ? null : `${day}T00:00:00.000Z`;
}
