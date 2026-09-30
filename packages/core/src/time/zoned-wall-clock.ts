/**
 * Wall clock <-> instant in a named IANA zone, with Intl only (no date
 * library).
 *
 * A WALL CLOCK is what a person reads off a clock on the wall of the
 * warehouse: "2026-10-03 14:00", with no zone and no offset. An INSTANT is a
 * point on the timeline (epoch milliseconds, or an ISO string with Z). Order
 * times are stored as instants (timestamptz) and entered and printed as wall
 * clocks in the ORGANIZATION's zone, never the device's or the server's.
 *
 * WHY THIS LIVES IN CORE (F2-4, moved 2026-09-29). Two copies of the same
 * arithmetic existed: `zonedParts` and `zoneOffsetMs` in
 * apps/web/src/server/actions/order-requests.ts (SP-047: the AI needed-by
 * suggestion, which read "-07:00" as Pacific all year and was an hour off every
 * winter), and private twins in ./org-timezone.ts (startOfOrgDay). F2-4 adds
 * a third caller, the needed-by revision (web dialog, phone sheet and the
 * server that converts what they send), so the arithmetic moved here once and
 * every caller uses this copy (recurring pattern #26: a fix applied to one copy
 * of a duplicated function is not a fix).
 *
 * HOW IT WORKS. Format an instant in the zone, read the parts back as if they
 * were UTC, and the difference is that zone's offset at that instant. Going
 * the other way takes two passes, because the offset needed is the one in
 * effect at the ANSWER, not at the first guess, and the two differ across a
 * daylight-saving change.
 *
 * DAYLIGHT-SAVING EDGES.
 *   - A wall clock that happens twice (the fall-back hour, 01:30 on
 *     2026-11-01 in Los Angeles) resolves to one of its two occurrences: the
 *     FIRST in zones west of UTC (01:30 PDT in Los Angeles; St Johns and
 *     Santiago too), the SECOND in zones east of it and at UTC+0 (Auckland,
 *     Sydney, Lord Howe, Chatham, London, Dublin, Casablanca, Troll). Both
 *     are real instants for that wall clock. A stored instant at the other
 *     occurrence (or one with seconds) therefore reads back as a wall clock
 *     that converts to a different instant, so the needed-by service keeps
 *     the stored instant when the wall clock sent equals the stored one's
 *     (re-saving an unedited date answers "Nothing changed").
 *   - A wall clock that never happens (the spring-forward hour, 02:30 on
 *     2027-03-14 in Los Angeles) is refused by the strict conversion (null);
 *     the lenient one keeps SP-047's behaviour and answers an hour early.
 *   - A calendar date that does not exist (Feb 30, 25:00) is refused by the
 *     strict conversion; the lenient one rolls it over as Date.UTC does.
 *
 * PLATFORM NOTE. Intl.DateTimeFormat with a named zone. Node (the server) has
 * full ICU. The phone's Hermes resolves the zones its ICU knows, and
 * resolveOrgTimezone (./org-timezone.ts) already degrades an unknown one to the
 * documented default before it reaches here. Hermes also types only the date
 * fields of a formatter that carries a date and a time, so the date and the
 * time are read from two formatters (zonedParts); with one, every time read on
 * the phone as midnight. Pinned against the Hermes stand-in in the tests.
 */

/** A wall clock, fields as a person writes them (month 1-12). */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What an instant reads as on a wall clock in a zone, to the second. */
export interface ZonedParts extends WallClock {
  second: number;
}

// Two formatters per zone, never one: Hermes on iOS (the phone) types only the
// DATE fields of a formatter that carries a date and a time, and returns the
// hour, minute and second as untyped literals (measured 2026-09-26, the
// stand-in is ./__fixtures__/hermes-like-intl.ts; rentals/emails.ts found it
// first). A date-only and a time-only formatter are typed on every engine.
// Cached per zone, and dropped whenever Intl.DateTimeFormat itself is another
// constructor (a test's engine stand-in), so a cached formatter never answers
// for an engine it was not made by.
type ZoneFormatters = { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
const FORMATTERS = new Map<string, ZoneFormatters>();
let formattersFrom: unknown = null;

function formattersFor(zone: string): ZoneFormatters {
  if (formattersFrom !== Intl.DateTimeFormat) {
    FORMATTERS.clear();
    formattersFrom = Intl.DateTimeFormat;
  }
  let fmt = FORMATTERS.get(zone);
  if (!fmt) {
    fmt = {
      date: new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      time: new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };
    FORMATTERS.set(zone, fmt);
  }
  return fmt;
}

function epochMs(at: Date | number): number {
  return at instanceof Date ? at.getTime() : at;
}

/** Copies the typed `wanted` parts of one formatting into `out`. */
function readParts(
  parts: Intl.DateTimeFormatPart[],
  wanted: readonly (keyof ZonedParts)[],
  out: ZonedParts,
): void {
  for (const key of wanted) {
    const value = Number(parts.find((p) => p.type === key)?.value);
    // An engine that leaves a field untyped would otherwise read as 0 here
    // (a date at midnight, a wrong offset, an instant hours off, silently).
    if (!Number.isFinite(value)) {
      throw new RangeError(`This runtime's Intl gave no ${key} for the time zone`);
    }
    out[key] = value;
  }
}

/** The wall clock `at` reads as in `zone`. Throws a RangeError for a zone the
 *  runtime does not know (pass it through resolveOrgTimezone first), and for
 *  an engine whose Intl leaves a date or time field untyped. */
export function zonedParts(at: Date | number, zone: string): ZonedParts {
  const d = new Date(epochMs(at));
  const fmt = formattersFor(zone);
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  readParts(fmt.date.formatToParts(d), ['year', 'month', 'day'], out);
  readParts(fmt.time.formatToParts(d), ['hour', 'minute', 'second'], out);
  // Some ICU builds print midnight as "24" even with h23 (the h24 cycle);
  // left alone, Date.UTC would roll the day forward by one.
  out.hour %= 24;
  return out;
}

/** Milliseconds `zone` is ahead of UTC at `at` (negative west of UTC). */
export function zoneOffsetMs(at: Date | number, zone: string): number {
  const ms = epochMs(at);
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** "YYYY-MM-DDTHH:mm", the shape a browser datetime-local input uses. */
export function wallClockString(w: WallClock): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** The wall clock `at` reads as in `zone`, as "YYYY-MM-DDTHH:mm". */
export function formatWallClock(at: Date | number, zone: string): string {
  return wallClockString(zonedParts(at, zone));
}

// "YYYY-MM-DD", optionally followed by "THH:mm" (or " HH:mm"), optionally with
// seconds and a fraction, which are accepted and ignored. Never a zone: a
// value that carries its own offset is an instant, not a wall clock.
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/**
 * Reads "YYYY-MM-DDTHH:mm" (seconds tolerated and ignored). A bare date is a
 * wall clock only when `dateOnlyHour` says which hour it means (the AI
 * suggestion reads a date-only note as 09:00); otherwise it is refused, never
 * read as UTC midnight (JS's `new Date('2027-01-15')`, a different day in any
 * zone west of UTC). Null for anything else. The fields are not range-checked
 * here: the strict conversion refuses a date or time that does not exist.
 */
export function parseWallClock(
  raw: string,
  opts: { dateOnlyHour?: number } = {},
): WallClock | null {
  const m = WALL_CLOCK_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (h === undefined && opts.dateOnlyHour === undefined) return null;
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: h === undefined ? (opts.dateOnlyHour as number) : Number(h),
    minute: mi === undefined ? 0 : Number(mi),
  };
}

/**
 * The instant a wall clock in `zone` names, as epoch milliseconds.
 *
 * `strict` (the default) answers null when that wall clock never happens in
 * the zone: a date that does not exist (Feb 30, hour 24, minute 60) or a time
 * inside the spring-forward gap. It checks by converting back: the answer must
 * read as exactly the wall clock asked for. `strict: false` is SP-047's
 * original arithmetic, unchanged (the AI suggestion keeps it).
 *
 * A string is read with parseWallClock (a time is required). Null for a
 * string that is not a wall clock.
 */
export function wallClockToInstant(
  wall: WallClock | string,
  zone: string,
  opts: { strict?: boolean } = {},
): number | null {
  const w = typeof wall === 'string' ? parseWallClock(wall) : wall;
  if (!w) return null;
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  if (!Number.isFinite(wallAsUtc)) return null;
  // Pass 1 guesses with the offset in effect at the wall time read as UTC;
  // pass 2 re-resolves with the offset in effect at that guess, which is what
  // lands a deadline next to a daylight-saving change on the right instant.
  const firstGuess = wallAsUtc - zoneOffsetMs(wallAsUtc, zone);
  const t = wallAsUtc - zoneOffsetMs(firstGuess, zone);
  if (!Number.isFinite(t)) return null;
  if (opts.strict !== false && formatWallClock(t, zone) !== wallClockString(w)) return null;
  return t;
}
