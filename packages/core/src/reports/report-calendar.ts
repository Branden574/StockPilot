/**
 * REPORT CALENDAR — the month calendar Book Order Totals uses to pick exact
 * days, shared by the web popover and the phone sheet (plan 3.4).
 *
 * Every day here is an org-local 'YYYY-MM-DD' string, and every rule is
 * integer arithmetic on those strings: this file never builds a date object
 * in the device's zone and never asks the platform for weekday or month
 * names (the phone's engine ships a reduced set of those, and a device zone
 * would move a day across midnight). SQL turns the chosen days into instants
 * in the organization's zone (0379's half-open bounds), so a daylight-saving
 * day is an ordinary cell here. A source guard in the test keeps it so.
 *
 * Weeks start on Sunday (plan D5), the same week "This week" uses in SQL.
 * Days run from 2000-01-01 to 2100-12-31, the SQL bounds.
 */

import { validateCustomDate } from './book-order-totals';

export interface CalendarMonth {
  y: number;
  /** 1 to 12. */
  m: number;
}

export interface CalendarCell {
  ymd: string;
  /** Day of the month, 1 to 31. */
  day: number;
}

/** One week of a month grid: seven cells, Sunday first; null outside the
 *  month. */
export type CalendarWeek = (CalendarCell | null)[];

export const CALENDAR_MIN_DAY = '2000-01-01';
export const CALENDAR_MAX_DAY = '2100-12-31';
export const CALENDAR_MIN_MONTH: Readonly<CalendarMonth> = Object.freeze({ y: 2000, m: 1 });
export const CALENDAR_MAX_MONTH: Readonly<CalendarMonth> = Object.freeze({ y: 2100, m: 12 });
/** Weeks start on Sunday (0). */
export const CALENDAR_WEEK_STARTS_ON = 0;

// ── Words (the wording guard renders these too) ─────────────────────────────

export const CALENDAR_WEEKDAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
export const CALENDAR_WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export const CALENDAR_MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const CALENDAR_COPY = {
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  startDate: 'Start date',
  endDate: 'End date',
  chooseStartDate: 'Choose a start date',
  chooseEndDate: 'Choose an end date',
} as const;

// ── Day arithmetic ──────────────────────────────────────────────────────────

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days in a month of the Gregorian calendar. */
export function daysInMonth(y: number, m: number): number {
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new RangeError(`not a month: ${y}-${m}`);
  }
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v);
}

function pad4(v: number): string {
  const s = String(v);
  return s.length >= 4 ? s : `${'0000'.slice(s.length)}${s}`;
}

function toYmd(y: number, m: number, d: number): string {
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

/** A real calendar day written YYYY-MM-DD (years 0001-9999), else null. */
function parseDay(ymd: unknown): { y: number; m: number; d: number } | null {
  if (typeof ymd !== 'string') return null;
  const r = YMD_RE.exec(ymd);
  if (!r) return null;
  const y = Number(r[1]);
  const m = Number(r[2]);
  const d = Number(r[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function mustParse(ymd: string): { y: number; m: number; d: number } {
  const p = parseDay(ymd);
  if (!p) throw new RangeError(`not a YYYY-MM-DD day: ${String(ymd)}`);
  return p;
}

/** Whether a value is a real day the report accepts (2000-01-01 to
 *  2100-12-31; the same rule as validateCustomDate). */
export function isCalendarDay(ymd: unknown): ymd is string {
  return validateCustomDate(ymd);
}

/** Days since 1970-01-01 (H. Hinnant's days_from_civil; integers only). */
function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The day for a day number (civil_from_days). */
function fromDayNumber(z0: number): string {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return toYmd(y, m, d);
}

const SAKAMOTO = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

/** The weekday of a day, 0 = Sunday (Sakamoto's method). */
export function dayOfWeek(ymd: string): number {
  const { y, m, d } = mustParse(ymd);
  const yy = m < 3 ? y - 1 : y;
  return (
    (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + SAKAMOTO[m - 1]! + d) %
    7
  );
}

/** The day `n` days later (earlier for a negative n). Not clamped. */
export function addDays(ymd: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`not a whole number of days: ${n}`);
  const { y, m, d } = mustParse(ymd);
  return fromDayNumber(dayNumber(y, m, d) + n);
}

/** The month of a day. */
export function monthOf(ymd: string): CalendarMonth {
  const { y, m } = mustParse(ymd);
  return { y, m };
}

/** Negative, zero or positive as `a` is before, the same as or after `b`. */
export function compareMonths(a: CalendarMonth, b: CalendarMonth): number {
  return a.y * 12 + a.m - (b.y * 12 + b.m);
}

/** A month held inside 2000-01 .. 2100-12. */
export function clampMonth(month: CalendarMonth): CalendarMonth {
  if (compareMonths(month, CALENDAR_MIN_MONTH) < 0) return { ...CALENDAR_MIN_MONTH };
  if (compareMonths(month, CALENDAR_MAX_MONTH) > 0) return { ...CALENDAR_MAX_MONTH };
  return { y: month.y, m: month.m };
}

/** The month `n` months later (earlier for a negative n), held inside
 *  2000-01 .. 2100-12. */
export function addMonths(month: CalendarMonth, n: number): CalendarMonth {
  if (!Number.isInteger(n)) throw new RangeError(`not a whole number of months: ${n}`);
  const index = month.y * 12 + (month.m - 1) + n;
  return clampMonth({ y: Math.floor(index / 12), m: (((index % 12) + 12) % 12) + 1 });
}

/** A day held inside 2000-01-01 .. 2100-12-31. */
export function clampDay(ymd: string): string {
  if (ymd < CALENDAR_MIN_DAY) return CALENDAR_MIN_DAY;
  if (ymd > CALENDAR_MAX_DAY) return CALENDAR_MAX_DAY;
  return ymd;
}

/** Whether there is a month before / after this one inside the bounds (for
 *  the Previous month and Next month buttons). */
export function canShowPreviousMonth(month: CalendarMonth): boolean {
  return compareMonths(month, CALENDAR_MIN_MONTH) > 0;
}
export function canShowNextMonth(month: CalendarMonth): boolean {
  return compareMonths(month, CALENDAR_MAX_MONTH) < 0;
}

// ── The month grid ──────────────────────────────────────────────────────────

/**
 * A month as 6 weeks of 7 cells, Sunday first, null outside the month. Always
 * six rows, so the grid keeps its height from month to month.
 */
export function monthGrid(y: number, m: number): CalendarWeek[] {
  const days = daysInMonth(y, m);
  const lead = dayOfWeek(toYmd(y, m, 1)); // Sunday start: the weekday is the offset
  const weeks: CalendarWeek[] = [];
  for (let w = 0; w < 6; w++) {
    const week: CalendarWeek = [];
    for (let c = 0; c < 7; c++) {
      const day = w * 7 + c - lead + 1;
      week.push(day >= 1 && day <= days ? { ymd: toYmd(y, m, day), day } : null);
    }
    weeks.push(week);
  }
  return weeks;
}

/** `count` months in a row from `anchor`, moved back when needed so the last
 *  stays inside the bounds (the web shows two months side by side). */
export function calendarVisibleMonths(anchor: CalendarMonth, count: number): CalendarMonth[] {
  const n = Math.max(1, Math.trunc(count));
  let first = clampMonth(anchor);
  const lastAllowedFirst = addMonths(CALENDAR_MAX_MONTH, -(n - 1));
  if (compareMonths(first, lastAllowedFirst) > 0) first = lastAllowedFirst;
  const out: CalendarMonth[] = [];
  for (let i = 0; i < n; i++) out.push(addMonths(first, i));
  return out;
}

/** The first visible month after moving to `ymd`: unchanged when `ymd` is
 *  already shown, else the least move that shows it. */
export function calendarEnsureVisible(
  anchor: CalendarMonth,
  count: number,
  ymd: string,
): CalendarMonth {
  const shown = calendarVisibleMonths(anchor, count);
  const target = clampMonth(monthOf(ymd));
  const first = shown[0]!;
  const last = shown[shown.length - 1]!;
  if (compareMonths(target, first) < 0) return target;
  if (compareMonths(target, last) > 0) {
    return calendarVisibleMonths(addMonths(target, -(shown.length - 1)), shown.length)[0]!;
  }
  return first;
}

// ── Picking a range ─────────────────────────────────────────────────────────

export type CalendarEditing = 'start' | 'end';

/** The range being picked. Nothing is requested while it changes: only the
 *  control's Apply sends it (brief 18). */
export interface CalendarRangeDraft {
  start: string | null;
  end: string | null;
  /** Which end the next picked day sets. */
  editing: CalendarEditing;
}

export const EMPTY_CALENDAR_RANGE: Readonly<CalendarRangeDraft> = Object.freeze({
  start: null,
  end: null,
  editing: 'start',
});

/**
 * One picked day (plan 3.4), the same rule on both platforms:
 *   - editing the start: the day becomes the start (an end before it is
 *     cleared), then the end is edited next;
 *   - editing the end: a day before the start starts again from that day; any
 *     other day becomes the end and the range is complete (the next pick
 *     edits the start). Picking one day twice gives a one-day range.
 * A day outside 2000-01-01 .. 2100-12-31 changes nothing.
 */
export function rangePick(state: CalendarRangeDraft, ymd: string): CalendarRangeDraft {
  if (!isCalendarDay(ymd)) return state;
  if (state.editing === 'start' || state.start === null) {
    const end = state.end !== null && ymd > state.end ? null : state.end;
    return { start: ymd, end, editing: 'end' };
  }
  if (ymd < state.start) return { start: ymd, end: null, editing: 'end' };
  return { start: state.start, end: ymd, editing: 'start' };
}

/** Choose which end the next picked day sets (the Start date / End date
 *  field that opened or was focused). */
export function rangeEdit(state: CalendarRangeDraft, editing: CalendarEditing): CalendarRangeDraft {
  return { ...state, editing };
}

/** Both ends set, real days in the bounds, the start on or before the end:
 *  Apply may send it. */
export function rangeComplete(
  state: Pick<CalendarRangeDraft, 'start' | 'end'>,
): state is { start: string; end: string } {
  return (
    isCalendarDay(state.start) &&
    isCalendarDay(state.end) &&
    (state.start as string) <= (state.end as string)
  );
}

/**
 * Where a picker opens: the range's resolved days when it has them (a
 * preset's days from the answer, or the custom range), else empty; the month
 * of its first day, else the month of `today` (the answer's org-local day),
 * else null (no answer yet: the control chooses).
 */
export function calendarDraftFrom(
  range: { from: string | null; to: string | null } | null | undefined,
  today: string | null | undefined,
): { draft: CalendarRangeDraft; month: CalendarMonth | null } {
  if (range && rangeComplete({ start: range.from, end: range.to })) {
    return {
      draft: { start: range.from, end: range.to, editing: 'start' },
      month: monthOf(range.from as string),
    };
  }
  return {
    draft: { ...EMPTY_CALENDAR_RANGE },
    month: isCalendarDay(today) ? monthOf(today) : null,
  };
}

/** How one day cell looks while a range is picked. */
export interface CalendarDayState {
  isStart: boolean;
  isEnd: boolean;
  /** The start or the end (filled). */
  selected: boolean;
  /** Strictly between the start and the end (the tinted band). */
  inRange: boolean;
  /** Inside the band a pointer hover previews while the end is edited. */
  inPreview: boolean;
  /** The organization's today (outlined). */
  isToday: boolean;
}

export function calendarDayState(
  ymd: string,
  draft: CalendarRangeDraft,
  opts: { today?: string | null; hover?: string | null } = {},
): CalendarDayState {
  const { start, end } = draft;
  const isStart = start !== null && ymd === start;
  const isEnd = end !== null && ymd === end;
  const inRange = start !== null && end !== null && ymd > start && ymd < end;
  const hover = opts.hover ?? null;
  const inPreview =
    draft.editing === 'end' &&
    start !== null &&
    end === null &&
    hover !== null &&
    hover > start &&
    ymd > start &&
    ymd <= hover;
  return {
    isStart,
    isEnd,
    selected: isStart || isEnd,
    inRange,
    inPreview,
    isToday: opts.today !== null && opts.today !== undefined && ymd === opts.today,
  };
}

// ── Keyboard (the web grid; WAI-ARIA date picker keys) ──────────────────────

export const CALENDAR_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;
export type CalendarKey = (typeof CALENDAR_KEYS)[number];

/** The same day of the month `n` months away, on that month's last day when
 *  it is shorter (Jan 31 -> Feb 28). */
function sameDayInMonth(ymd: string, n: number): string {
  const { y, m, d } = mustParse(ymd);
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = (((index % 12) + 12) % 12) + 1;
  if (ty < 1) return CALENDAR_MIN_DAY;
  return toYmd(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

/**
 * The day focus moves to for a key: arrows one day or one week; PageUp /
 * PageDown one month (with Shift one year); Home / End the start (Sunday) and
 * end (Saturday) of the week. Held inside 2000-01-01 .. 2100-12-31. Null for
 * any other key (the grid leaves it to the browser).
 */
export function keyMove(ymd: string, key: string, opts: { shift?: boolean } = {}): string | null {
  let next: string;
  switch (key) {
    case 'ArrowLeft':
      next = addDays(ymd, -1);
      break;
    case 'ArrowRight':
      next = addDays(ymd, 1);
      break;
    case 'ArrowUp':
      next = addDays(ymd, -7);
      break;
    case 'ArrowDown':
      next = addDays(ymd, 7);
      break;
    case 'PageUp':
      next = sameDayInMonth(ymd, opts.shift ? -12 : -1);
      break;
    case 'PageDown':
      next = sameDayInMonth(ymd, opts.shift ? 12 : 1);
      break;
    case 'Home':
      next = addDays(ymd, -((dayOfWeek(ymd) - CALENDAR_WEEK_STARTS_ON + 7) % 7));
      break;
    case 'End':
      next = addDays(ymd, 6 - ((dayOfWeek(ymd) - CALENDAR_WEEK_STARTS_ON + 7) % 7));
      break;
    default:
      return null;
  }
  return clampDay(next);
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** 'September 2026'. */
export function calendarMonthTitle(month: CalendarMonth): string {
  const name = CALENDAR_MONTHS_LONG[month.m - 1];
  if (!name) throw new RangeError(`not a month: ${month.m}`);
  return `${name} ${month.y}`;
}

/** A day cell's spoken name: 'Tuesday, September 1, 2026'. */
export function calendarDayLabel(ymd: string): string {
  const { y, m, d } = mustParse(ymd);
  return `${CALENDAR_WEEKDAYS_LONG[dayOfWeek(ymd)]}, ${CALENDAR_MONTHS_LONG[m - 1]} ${d}, ${y}`;
}

/** The organization's today for the calendar: the day of the answer's
 *  org-local generation time ('YYYY-MM-DD HH:MI' from SQL), never the
 *  device's clock. Null without an answer. */
export function calendarToday(generatedAtLocal: string | null | undefined): string | null {
  if (typeof generatedAtLocal !== 'string') return null;
  const day = generatedAtLocal.slice(0, 10);
  return parseDay(day) ? day : null;
}
