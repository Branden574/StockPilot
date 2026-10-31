import { formatOrgDate, formatOrgTime } from '@/lib/timezone';

/**
 * When a team calendar event happens, in words, in the ORGANIZATION's zone:
 * "Wed, Oct 7, 2026 · 2:00 PM – 3:00 PM", "... · All day", or start → end
 * across days. Moved out of the event page (small fixes slice 8), where it
 * printed every event in the formatters' default zone (Pacific) whatever the
 * organization's; the page now passes the organization's zone, as the
 * calendar does. Whether start and end fall on one day is decided in that
 * zone too.
 */
export function formatEventRange(
  startsAt: string,
  endsAt: string | null,
  allDay: boolean,
  timeZone: string,
): string {
  const start = new Date(startsAt);
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  };
  const date = (d: Date) => formatOrgDate(d, dateOpts, timeZone);
  const time = (d: Date) => formatOrgTime(d, timeOpts, timeZone);
  if (allDay) {
    return `${date(start)} · All day`;
  }
  if (!endsAt) {
    return `${date(start)} · ${time(start)}`;
  }
  const end = new Date(endsAt);
  // Compare the organization's calendar days (NOT the JS Date getters, which
  // read the server's zone), so "same day" holds when both fall on one day
  // there even if UTC midnight splits them.
  const sameDay = formatOrgDate(start, {}, timeZone) === formatOrgDate(end, {}, timeZone);
  if (sameDay) {
    return `${date(start)} · ${time(start)} – ${time(end)}`;
  }
  return `${date(start)} ${time(start)} → ${date(end)} ${time(end)}`;
}
