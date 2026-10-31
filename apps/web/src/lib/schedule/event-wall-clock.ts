/**
 * An event's date and time as New and Edit event show and take them: a WALL
 * CLOCK ("2026-11-07T09:00", what a browser datetime-local input holds) in the
 * ORGANIZATION's zone, the zone the team calendar and an event's page draw in
 * (small fixes slice 8). The form read and wrote that value in the viewer's
 * zone (new Date(local)), so a viewer in another zone saved a calendar cell's
 * "+ Add" on another day, and Edit opened on a time the event's page did not
 * print.
 *
 * THE HOUR THE CLOCKS GO BACK (slice 8 review). A wall clock in that hour
 * happens twice (1:30 AM on 2026-11-01 in Los Angeles is 08:30Z in PDT, then
 * 09:30Z in PST), and a datetime-local field cannot say which. Converting a
 * field back answers one of the two (core's rule: the first west of UTC, the
 * second east of it), so Edit event saved an event at the other one an hour
 * away, unchanged, and the service re-armed its reminders. So the save goes
 * through eventInstantsFromInputs: a field the person did not change sends
 * the instant it opened on, as stored; a changed time next to an unchanged
 * time in the same repeated hour is read in that time's occurrence, so the
 * event keeps its length; any other time is read as a new time always was.
 * The needed-by revision keeps its stored instant the same way
 * (core zoned-wall-clock.ts, DAYLIGHT-SAVING EDGES).
 *
 * The arithmetic is core's (zoned-wall-clock.ts), the one copy every org-zone
 * caller uses. Plain module: the client form and its tests import it.
 */
import {
  formatWallClock,
  parseWallClock,
  wallClockString,
  wallClockToInstant,
  zonedParts,
  zoneOffsetMs,
  type WallClock,
} from '@stockpilot/core';

const SECONDS_RE = /T\d{2}:\d{2}:(\d{2})(?:\.\d+)?$/;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The input value for an instant, in `zone`. Seconds are written only when
 * the instant has them, so an event saved with seconds (by another client)
 * keeps them across an unchanged save, and every other one shows HH:mm.
 */
export function eventInputFromInstant(at: string | number | Date, zone: string): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const base = formatWallClock(ms, zone);
  const seconds = new Date(ms).getUTCSeconds();
  return seconds === 0 ? base : `${base}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Every instant that reads as `w` in `zone`, to the minute, earliest first:
 * one for most wall clocks, two in the hour the clocks go back, none in the
 * hour they skip. The offsets tried are those in effect a day either side of
 * the wall clock read as UTC, which straddle any one daylight-saving change.
 */
export function wallClockOccurrences(w: WallClock, zone: string): number[] {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  if (!Number.isFinite(asUtc)) return [];
  const want = wallClockString(w);
  const found = new Set<number>();
  for (const probe of [asUtc - DAY_MS, asUtc, asUtc + DAY_MS]) {
    const t = asUtc - zoneOffsetMs(probe, zone);
    if (formatWallClock(t, zone) === want) found.add(t);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Which occurrence of the repeated hour `at` is in `zone` (0 the first, 1 the
 * second), and on what date; null when its wall clock happens once.
 */
function repeatedHourOccurrence(at: number, zone: string): { index: number; date: string } | null {
  const parts = zonedParts(at, zone);
  const all = wallClockOccurrences(parts, zone);
  if (all.length < 2) return null;
  const index = all.indexOf(at - (((at % MINUTE_MS) + MINUTE_MS) % MINUTE_MS));
  return index === -1 ? null : { index, date: wallClockString(parts).slice(0, 10) };
}

/**
 * The instant, as an ISO string, that an input value names in `zone`; null
 * when it is not a date and time, or names a time that never happens there
 * (the spring-forward hour): strict, never moved to another hour unseen.
 * Seconds in the value are kept.
 *
 * `sameHourAs`: an instant this value sits next to (the event's other, unchanged
 * time). When both are in the same repeated hour, the value is read in that
 * instant's occurrence of it; otherwise the argument changes nothing.
 */
export function eventInstantFromInput(
  local: string,
  zone: string,
  sameHourAs?: string | null,
): string | null {
  const w = parseWallClock(local);
  if (!w) return null;
  let ms = wallClockToInstant(w, zone);
  if (ms === null) return null;
  const ref = sameHourAs ? Date.parse(sameHourAs) : Number.NaN;
  if (Number.isFinite(ref)) {
    const mine = wallClockOccurrences(w, zone);
    const theirs = mine.length === 2 ? repeatedHourOccurrence(ref, zone) : null;
    if (theirs && theirs.date === wallClockString(w).slice(0, 10)) {
      ms = mine[theirs.index] ?? ms;
    }
  }
  const seconds = SECONDS_RE.exec(local.trim());
  return new Date(ms + (seconds ? Number(seconds[1]) * 1000 : 0)).toISOString();
}

/** The stored instant when the field still shows the wall clock it opened on. */
function keptInstant(
  local: string,
  zone: string,
  stored: string | null | undefined,
): string | null {
  if (!local || !stored) return null;
  return eventInputFromInstant(stored, zone) === local ? stored : null;
}

/**
 * The instants New and Edit event save for their Starts and Ends fields (and
 * the overlap warning reads), in `zone`. `stored` is the event as Edit opened
 * it (none for a new event).
 *
 *   - A field still showing what it opened on sends the stored instant,
 *     exactly as stored (PostgREST's text, microseconds included), as the
 *     needed-by save sends the page's own text.
 *   - A changed time next to an unchanged one in the same repeated hour is
 *     read in that one's occurrence (eventInstantFromInput `sameHourAs`).
 *   - Anything else is read in `zone` as before.
 *
 * `startsAt` is null when the start is blank or never happens; `endsAt` is
 * null when the end is blank or never happens (the form tells the two apart
 * by the field).
 */
export function eventInstantsFromInputs(
  fields: { startsAt: string; endsAt: string },
  zone: string,
  stored: { startsAt?: string | null; endsAt?: string | null } = {},
): { startsAt: string | null; endsAt: string | null } {
  const keptStart = keptInstant(fields.startsAt, zone, stored.startsAt);
  const keptEnd = keptInstant(fields.endsAt, zone, stored.endsAt);
  return {
    startsAt: keptStart ?? eventInstantFromInput(fields.startsAt, zone, keptEnd),
    endsAt: fields.endsAt
      ? (keptEnd ?? eventInstantFromInput(fields.endsAt, zone, keptStart))
      : null,
  };
}

/** The next half-hour on the wall clock in `zone` from `now`, as an input value. */
export function nextHalfHourInput(now: number, zone: string): string {
  const p = zonedParts(now, zone);
  // Wall-clock arithmetic only (Date.UTC carries a minute of 60 into the next
  // hour, day, month or year); no zone offset is involved.
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, Math.ceil(p.minute / 30) * 30));
  return wallClockString({
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  });
}
