/**
 * THE VIEWER'S ZONE, for pages that print instants for the person reading
 * them (the platform console's security pages, owner request 2026-11-24:
 * "change it to pacific standard time based off what I chose in my
 * settings"). The zone is the one the viewer chose (their organization's
 * `organizations.timezone`, Settings, then Organization, then Timezone); with
 * none, the browser's zone on the client and UTC on the server. Stored times
 * stay UTC: these only print them.
 *
 * Unlike resolveOrgTimezone (org-timezone.ts), an unusable zone here is "no
 * zone" (null), never the documented Pacific default: the caller then takes
 * its own fallback (the browser's zone, or UTC), so nothing claims a choice
 * the viewer did not make.
 */
import { wallClockToInstant, zonedParts } from './zoned-wall-clock';

const USABLE = new Map<string, boolean>();

/** The zone when this runtime's Intl accepts it, else null. Blank is null. */
export function usableTimeZone(raw: unknown): string | null {
  const zone = typeof raw === 'string' ? raw.trim() : '';
  if (!zone) return null;
  let ok = USABLE.get(zone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      ok = true;
    } catch {
      ok = false;
    }
    USABLE.set(zone, ok);
  }
  return ok ? zone : null;
}

/** The runtime's own zone (the browser's, on the client), or UTC when it names none this runtime accepts. */
export function runtimeTimeZone(): string {
  try {
    return usableTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneNamePart(at: Date | number, zone: string, style: 'short' | 'long'): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style })
      .formatToParts(new Date(at instanceof Date ? at.getTime() : at))
      .find((x) => x.type === 'timeZoneName');
    return part?.value ? part.value : null;
  } catch {
    return null;
  }
}

/**
 * The zone's short name at that instant, as the formatter gives it: "PST" or
 * "PDT" for America/Los_Angeles, "UTC", or a GMT offset ("GMT+1") where
 * English has no short name. The zone id when the engine gives none.
 */
export function zoneShortName(at: Date | number, zone: string): string {
  return zoneNamePart(at, zone, 'short') ?? zone;
}

/**
 * The zone in words for a line that says which zone the times are in:
 * "Pacific Standard Time (America/Los_Angeles)", or "UTC".
 */
export function zoneLongWords(at: Date | number, zone: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const long = zoneNamePart(at, zone, 'long');
  return long && long !== zone ? `${long} (${zone})` : zone;
}

/**
 * How a clock is written: '24h' ("23:20"), the app's default, or '12h'
 * ("11:20 PM"), which the platform console's security pages use (owner,
 * 2026-11-24). An option of the formatters that write a clock, never a page's
 * own copy.
 */
export type ClockStyle = '24h' | '12h';

/**
 * A wall clock's hour and minute as words: "23:20" on a 24-hour clock,
 * "11:20 PM" on a 12-hour one (midnight "12:00 AM", noon "12:00 PM"). Built
 * from the numbers, not from Intl, so every runtime writes the same plain
 * space before AM or PM (no hydration difference).
 */
export function clockWords(hour: number, minute: number, clock: ClockStyle = '24h'): string {
  const mm = String(minute).padStart(2, '0');
  if (clock === '24h') return `${String(hour).padStart(2, '0')}:${mm}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}

const HOUR_MS = 60 * 60 * 1000;

/** A calendar date as one number, so two days compare: 2027-03-14 is 20270314. */
const dayNumber = (p: { year: number; month: number; day: number }): number =>
  p.year * 10_000 + p.month * 100 + p.day;

/**
 * The instant the day holding `at` began in `zone`: the first instant that
 * reads as that calendar day there. Most days that is its midnight. On a day
 * whose clocks went forward over midnight (in 2027: America/Havana on 14
 * March, Atlantic/Azores on 28 March, America/Santiago on 5 September, and
 * Cairo and Beirut east of UTC) there is no midnight: the day began with the
 * change, at 01:00 on the clock, and that instant is the answer, never one in
 * the day before. On a day whose clocks went back over midnight, the first
 * midnight. So the answer always moves on from one day to the next (review
 * M1, 2026-11-24: the earlier lenient answer of 23:00 the day before held the
 * attack map's next midnight still for a day).
 */
export function dayStartInZone(at: Date | number, zone: string): number {
  const ms = at instanceof Date ? at.getTime() : at;
  const p = zonedParts(ms, zone);
  const day = dayNumber(p);
  // The day's midnight, worked out as if it exists: the answer when it reads
  // as this day, the millisecond before it as an earlier one, and it is not
  // after `at`. One look on almost every day.
  const midnight = wallClockToInstant(
    { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 },
    zone,
    { strict: false },
  );
  if (
    midnight !== null &&
    midnight <= ms &&
    dayNumber(zonedParts(midnight, zone)) === day &&
    dayNumber(zonedParts(midnight - 1, zone)) < day
  ) {
    return midnight;
  }
  // Otherwise the clocks changed over midnight: back from `at` an hour at a
  // time to an instant of an earlier day, then halve that hour to the
  // millisecond for the first instant of this one.
  let inDay = ms;
  let before = ms - HOUR_MS;
  for (let steps = 0; dayNumber(zonedParts(before, zone)) >= day; steps += 1) {
    if (steps >= 48) return Number.NaN;
    inDay = before;
    before -= HOUR_MS;
  }
  while (inDay - before > 1) {
    const mid = Math.floor((before + inDay) / 2);
    if (dayNumber(zonedParts(mid, zone)) >= day) inDay = mid;
    else before = mid;
  }
  return inDay;
}

/**
 * The instant the next day begins in `zone` (its first instant, as
 * dayStartInZone), after the day holding `dayStart`: always later than it.
 */
export function nextDayStartInZone(dayStart: Date | number, zone: string): number {
  const p = zonedParts(dayStart, zone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return dayStartInZone(
    // Noon of the next calendar day in the zone: well inside that day whatever its offset.
    wallClockToInstant(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: 12,
        minute: 0,
      },
      zone,
      { strict: false },
    ) ?? Number.NaN,
    zone,
  );
}
