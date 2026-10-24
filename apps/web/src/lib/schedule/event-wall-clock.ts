/**
 * An event's date and time as New and Edit event show and take them: a WALL
 * CLOCK ("2026-11-07T09:00", what a browser datetime-local input holds) in the
 * ORGANIZATION's zone, the zone the team calendar and an event's page draw in
 * (small fixes slice 8). The form read and wrote that value in the viewer's
 * zone (new Date(local)), so a viewer in another zone saved a calendar cell's
 * "+ Add" on another day, and Edit opened on a time the event's page did not
 * print.
 *
 * The arithmetic is core's (zoned-wall-clock.ts), the one copy every org-zone
 * caller uses. Plain module: the client form and its tests import it.
 */
import { formatWallClock, wallClockString, wallClockToInstant, zonedParts } from '@stockpilot/core';

const SECONDS_RE = /T\d{2}:\d{2}:(\d{2})(?:\.\d+)?$/;

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
 * The instant, as an ISO string, that an input value names in `zone`; null
 * when it is not a date and time, or names a time that never happens there
 * (the spring-forward hour): strict, never moved to another hour unseen.
 * Seconds in the value are kept.
 */
export function eventInstantFromInput(local: string, zone: string): string | null {
  const ms = wallClockToInstant(local, zone);
  if (ms === null) return null;
  const seconds = SECONDS_RE.exec(local.trim());
  return new Date(ms + (seconds ? Number(seconds[1]) * 1000 : 0)).toISOString();
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
