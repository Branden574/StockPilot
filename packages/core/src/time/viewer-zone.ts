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

/** The instant the day holding `at` began in `zone` (its midnight, or the first instant after a gap there). */
export function dayStartInZone(at: Date | number, zone: string): number {
  const p = zonedParts(at, zone);
  const wall = { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 };
  return (
    wallClockToInstant(wall, zone) ??
    // A zone whose clocks skipped midnight that day: the non-strict answer.
    wallClockToInstant(wall, zone, { strict: false }) ??
    Number.NaN
  );
}

/** The instant the next day begins in `zone`, after the day that began at `dayStart`. */
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
