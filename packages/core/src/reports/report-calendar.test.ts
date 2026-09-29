import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CALENDAR_COPY,
  CALENDAR_KEYS,
  CALENDAR_MAX_DAY,
  CALENDAR_MAX_MONTH,
  CALENDAR_MIN_DAY,
  CALENDAR_MIN_MONTH,
  CALENDAR_WEEKDAYS_LONG,
  CALENDAR_WEEKDAYS_SHORT,
  EMPTY_CALENDAR_RANGE,
  addDays,
  addMonths,
  calendarDayLabel,
  calendarDayState,
  calendarDraftFrom,
  calendarEnsureVisible,
  calendarMonthTitle,
  calendarToday,
  calendarVisibleMonths,
  canShowNextMonth,
  canShowPreviousMonth,
  clampDay,
  clampMonth,
  compareMonths,
  dayOfWeek,
  daysInMonth,
  isCalendarDay,
  keyMove,
  monthGrid,
  monthOf,
  rangeComplete,
  rangeEdit,
  rangePick,
  type CalendarRangeDraft,
} from './report-calendar';

// The TEST may use the platform's date object as an independent oracle; the
// module under test never does (the source guard at the end).
function utcYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
const DAY_MS = 86_400_000;

describe('day arithmetic against an independent oracle', () => {
  it('every day 2000-01-01 .. 2100-12-31: weekday, next day and the day number agree (exhaustive)', () => {
    let ms = Date.UTC(2000, 0, 1);
    const end = Date.UTC(2100, 11, 31);
    let ymd = CALENDAR_MIN_DAY;
    let days = 0;
    while (ms <= end) {
      expect(ymd).toBe(utcYmd(ms));
      expect(dayOfWeek(ymd)).toBe(new Date(ms).getUTCDay());
      const next = addDays(ymd, 1);
      expect(addDays(next, -1)).toBe(ymd);
      ymd = next;
      ms += DAY_MS;
      days++;
    }
    expect(ymd).toBe('2101-01-01');
    expect(days).toBe(36_890);
  }, 60_000);
  it('adds and subtracts large spans exactly', () => {
    expect(addDays('2000-01-01', 36_889)).toBe('2100-12-31');
    expect(addDays('2100-12-31', -36_889)).toBe('2000-01-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-09-29', 0)).toBe('2026-09-29');
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-9-1', 1)).toThrow(RangeError);
    expect(() => addDays('2026-09-01', 1.5)).toThrow(RangeError);
  });
  it('knows leap years: 2000 is one, 2100 is not', () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
  });
  it('daylight-saving days are ordinary days (the zone is SQL’s business)', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(dayOfWeek('2026-03-08')).toBe(0);
    expect(dayOfWeek('2026-11-01')).toBe(0);
    const march = monthGrid(2026, 3).flat().filter(Boolean);
    expect(march.map((c) => c!.ymd)).toContain('2026-03-08');
    expect(march).toHaveLength(31);
  });
  it('the named week cases (Sunday start)', () => {
    expect(dayOfWeek('2026-09-27')).toBe(0);
    expect(dayOfWeek('2026-09-29')).toBe(2);
    expect(dayOfWeek('2026-01-03')).toBe(6);
    expect(dayOfWeek('2027-01-01')).toBe(5);
  });
});

describe('the process zone never matters', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  it('gives the same answers in Auckland, UTC and Los Angeles', () => {
    const run = (zone: string) => {
      process.env.TZ = zone;
      return [
        dayOfWeek('2026-11-01'),
        addDays('2026-03-08', 1),
        calendarDayLabel('2026-09-01'),
        JSON.stringify(monthGrid(2026, 9)),
        keyMove('2026-09-01', 'End'),
      ];
    };
    const utc = run('UTC');
    expect(run('Pacific/Auckland')).toEqual(utc);
    expect(run('America/Los_Angeles')).toEqual(utc);
  });
});

describe('monthGrid', () => {
  it('February 2026 starts on a Sunday: four full weeks and two empty rows', () => {
    const g = monthGrid(2026, 2);
    expect(g).toHaveLength(6);
    for (const w of g) expect(w).toHaveLength(7);
    expect(g[0]![0]).toEqual({ ymd: '2026-02-01', day: 1 });
    expect(g[3]![6]).toEqual({ ymd: '2026-02-28', day: 28 });
    expect(g[4]!.every((c) => c === null)).toBe(true);
    expect(g[5]!.every((c) => c === null)).toBe(true);
  });
  it('September 2026 starts on a Tuesday', () => {
    const g = monthGrid(2026, 9);
    expect(g[0]!.slice(0, 2)).toEqual([null, null]);
    expect(g[0]![2]).toEqual({ ymd: '2026-09-01', day: 1 });
    expect(g[4]![3]).toEqual({ ymd: '2026-09-30', day: 30 });
  });
  it('every month in the bounds: 42 cells, each day once, in order, in its weekday column (exhaustive)', () => {
    let month = { ...CALENDAR_MIN_MONTH };
    let months = 0;
    for (;;) {
      const g = monthGrid(month.y, month.m);
      expect(g.flat()).toHaveLength(42);
      const days = g.flat().filter((c): c is NonNullable<typeof c> => c !== null);
      expect(days).toHaveLength(daysInMonth(month.y, month.m));
      days.forEach((c, i) => {
        expect(c.day).toBe(i + 1);
        expect(monthOf(c.ymd)).toEqual(month);
      });
      g.forEach((week) =>
        week.forEach((c, col) => {
          if (c) expect(dayOfWeek(c.ymd)).toBe(col);
        }),
      );
      months++;
      if (compareMonths(month, CALENDAR_MAX_MONTH) === 0) break;
      month = addMonths(month, 1);
    }
    expect(months).toBe(101 * 12);
  }, 60_000);
});

describe('months and bounds', () => {
  it('addMonths crosses years and holds 2000-01 .. 2100-12', () => {
    expect(addMonths({ y: 2026, m: 12 }, 1)).toEqual({ y: 2027, m: 1 });
    expect(addMonths({ y: 2026, m: 1 }, -1)).toEqual({ y: 2025, m: 12 });
    expect(addMonths({ y: 2026, m: 9 }, -21)).toEqual({ y: 2024, m: 12 });
    expect(addMonths({ y: 2000, m: 1 }, -1)).toEqual({ y: 2000, m: 1 });
    expect(addMonths({ y: 2100, m: 12 }, 1)).toEqual({ y: 2100, m: 12 });
    expect(clampMonth({ y: 1999, m: 5 })).toEqual(CALENDAR_MIN_MONTH);
    expect(clampMonth({ y: 2200, m: 5 })).toEqual(CALENDAR_MAX_MONTH);
    expect(canShowPreviousMonth({ y: 2000, m: 1 })).toBe(false);
    expect(canShowPreviousMonth({ y: 2000, m: 2 })).toBe(true);
    expect(canShowNextMonth({ y: 2100, m: 12 })).toBe(false);
    expect(canShowNextMonth({ y: 2100, m: 11 })).toBe(true);
    expect(clampDay('1999-12-31')).toBe(CALENDAR_MIN_DAY);
    expect(clampDay('2101-01-01')).toBe(CALENDAR_MAX_DAY);
    expect(clampDay('2026-09-29')).toBe('2026-09-29');
  });
  it('two months side by side never run past the last month', () => {
    expect(calendarVisibleMonths({ y: 2026, m: 12 }, 2)).toEqual([
      { y: 2026, m: 12 },
      { y: 2027, m: 1 },
    ]);
    expect(calendarVisibleMonths({ y: 2100, m: 12 }, 2)).toEqual([
      { y: 2100, m: 11 },
      { y: 2100, m: 12 },
    ]);
    expect(calendarVisibleMonths({ y: 1990, m: 1 }, 1)).toEqual([{ y: 2000, m: 1 }]);
  });
  it('moves the months only as far as needed to show a focused day', () => {
    const sep = { y: 2026, m: 9 };
    expect(calendarEnsureVisible(sep, 2, '2026-10-15')).toEqual(sep);
    expect(calendarEnsureVisible(sep, 2, '2026-11-01')).toEqual({ y: 2026, m: 10 });
    expect(calendarEnsureVisible(sep, 2, '2026-08-31')).toEqual({ y: 2026, m: 8 });
    expect(calendarEnsureVisible(sep, 1, '2027-02-01')).toEqual({ y: 2027, m: 2 });
    expect(calendarEnsureVisible({ y: 2100, m: 11 }, 2, '2100-12-31')).toEqual({ y: 2100, m: 11 });
  });
});

describe('rangePick (one rule on both platforms)', () => {
  const pick = (s: CalendarRangeDraft, ...days: string[]) => days.reduce(rangePick, s);
  it('start, then end: a complete range, then the next pick edits the start', () => {
    const a = rangePick(EMPTY_CALENDAR_RANGE, '2026-09-01');
    expect(a).toEqual({ start: '2026-09-01', end: null, editing: 'end' });
    expect(rangeComplete(a)).toBe(false);
    const b = rangePick(a, '2026-09-30');
    expect(b).toEqual({ start: '2026-09-01', end: '2026-09-30', editing: 'start' });
    expect(rangeComplete(b)).toBe(true);
  });
  it('the same day twice is a one-day range', () => {
    expect(pick(EMPTY_CALENDAR_RANGE, '2026-10-01', '2026-10-01')).toEqual({
      start: '2026-10-01',
      end: '2026-10-01',
      editing: 'start',
    });
  });
  it('an end before the start starts again from that day', () => {
    expect(pick(EMPTY_CALENDAR_RANGE, '2026-09-15', '2026-09-10')).toEqual({
      start: '2026-09-10',
      end: null,
      editing: 'end',
    });
  });
  it('editing the start keeps a later end and clears an earlier one', () => {
    const full: CalendarRangeDraft = { start: '2026-09-01', end: '2026-09-30', editing: 'start' };
    expect(rangePick(full, '2026-09-05')).toEqual({
      start: '2026-09-05',
      end: '2026-09-30',
      editing: 'end',
    });
    expect(rangePick(full, '2026-10-03')).toEqual({
      start: '2026-10-03',
      end: null,
      editing: 'end',
    });
    expect(rangePick(full, '2026-09-30')).toEqual({
      start: '2026-09-30',
      end: '2026-09-30',
      editing: 'end',
    });
  });
  it('opening the End field edits the end; with no start the day becomes the start', () => {
    const full: CalendarRangeDraft = { start: '2026-09-01', end: '2026-09-30', editing: 'start' };
    expect(rangePick(rangeEdit(full, 'end'), '2026-09-20')).toEqual({
      start: '2026-09-01',
      end: '2026-09-20',
      editing: 'start',
    });
    expect(rangePick(rangeEdit(EMPTY_CALENDAR_RANGE, 'end'), '2026-09-20')).toEqual({
      start: '2026-09-20',
      end: null,
      editing: 'end',
    });
  });
  it('ignores a day outside 2000-01-01 .. 2100-12-31 or not a day at all', () => {
    for (const bad of ['1999-12-31', '2101-01-01', '2026-02-30', 'soon']) {
      expect(rangePick(EMPTY_CALENDAR_RANGE, bad)).toBe(EMPTY_CALENDAR_RANGE);
    }
  });
  it('rangeComplete needs two real days in order', () => {
    expect(rangeComplete({ start: '2026-09-01', end: '2026-09-01' })).toBe(true);
    expect(rangeComplete({ start: '2026-09-02', end: '2026-09-01' })).toBe(false);
    expect(rangeComplete({ start: '2026-09-01', end: null })).toBe(false);
    expect(rangeComplete({ start: '2026-09-01', end: '2026-09-31' })).toBe(false);
  });
  it('opens on the resolved days, or on the month of the organization’s today', () => {
    expect(calendarDraftFrom({ from: '2026-09-01', to: '2026-09-29' }, '2026-09-29')).toEqual({
      draft: { start: '2026-09-01', end: '2026-09-29', editing: 'start' },
      month: { y: 2026, m: 9 },
    });
    expect(calendarDraftFrom({ from: null, to: null }, '2026-09-29')).toEqual({
      draft: { start: null, end: null, editing: 'start' },
      month: { y: 2026, m: 9 },
    });
    expect(calendarDraftFrom(null, null)).toEqual({
      draft: { start: null, end: null, editing: 'start' },
      month: null,
    });
  });
});

describe('calendarDayState', () => {
  const draft: CalendarRangeDraft = { start: '2026-09-10', end: '2026-09-20', editing: 'start' };
  it('marks the ends, the band between and today', () => {
    expect(calendarDayState('2026-09-10', draft, { today: '2026-09-29' })).toMatchObject({
      isStart: true,
      selected: true,
      inRange: false,
      isToday: false,
    });
    expect(calendarDayState('2026-09-15', draft)).toMatchObject({ inRange: true, selected: false });
    expect(calendarDayState('2026-09-20', draft)).toMatchObject({ isEnd: true, inRange: false });
    expect(calendarDayState('2026-09-29', draft, { today: '2026-09-29' }).isToday).toBe(true);
    expect(calendarDayState('2026-09-29', draft, { today: null }).isToday).toBe(false);
  });
  it('previews the band under a hover only while the end is being chosen', () => {
    const half: CalendarRangeDraft = { start: '2026-09-10', end: null, editing: 'end' };
    expect(calendarDayState('2026-09-12', half, { hover: '2026-09-14' }).inPreview).toBe(true);
    expect(calendarDayState('2026-09-14', half, { hover: '2026-09-14' }).inPreview).toBe(true);
    expect(calendarDayState('2026-09-15', half, { hover: '2026-09-14' }).inPreview).toBe(false);
    expect(calendarDayState('2026-09-10', half, { hover: '2026-09-14' }).inPreview).toBe(false);
    expect(calendarDayState('2026-09-12', half, { hover: '2026-09-05' }).inPreview).toBe(false);
    expect(calendarDayState('2026-09-12', draft, { hover: '2026-09-14' }).inPreview).toBe(false);
  });
});

describe('keyMove (WAI-ARIA date picker keys)', () => {
  it('arrows move a day or a week', () => {
    expect(keyMove('2026-09-01', 'ArrowLeft')).toBe('2026-08-31');
    expect(keyMove('2026-09-30', 'ArrowRight')).toBe('2026-10-01');
    expect(keyMove('2026-09-03', 'ArrowUp')).toBe('2026-08-27');
    expect(keyMove('2026-12-29', 'ArrowDown')).toBe('2027-01-05');
  });
  it('PageUp / PageDown move a month (Shift a year), onto a shorter month’s last day', () => {
    expect(keyMove('2026-01-31', 'PageDown')).toBe('2026-02-28');
    expect(keyMove('2024-01-31', 'PageDown')).toBe('2024-02-29');
    expect(keyMove('2026-03-31', 'PageUp')).toBe('2026-02-28');
    expect(keyMove('2026-12-15', 'PageDown')).toBe('2027-01-15');
    expect(keyMove('2024-02-29', 'PageDown', { shift: true })).toBe('2025-02-28');
    expect(keyMove('2026-09-29', 'PageUp', { shift: true })).toBe('2025-09-29');
  });
  it('Home and End go to Sunday and Saturday of the week', () => {
    expect(keyMove('2026-09-29', 'Home')).toBe('2026-09-27');
    expect(keyMove('2026-09-29', 'End')).toBe('2026-10-03');
    expect(keyMove('2026-09-27', 'Home')).toBe('2026-09-27');
    expect(keyMove('2026-10-03', 'End')).toBe('2026-10-03');
    expect(keyMove('2026-01-01', 'Home')).toBe('2025-12-28');
  });
  it('holds the bounds, and leaves other keys alone', () => {
    expect(keyMove('2000-01-01', 'ArrowLeft')).toBe('2000-01-01');
    expect(keyMove('2000-01-01', 'Home')).toBe('2000-01-01');
    expect(keyMove('2000-01-15', 'PageUp')).toBe('2000-01-01');
    expect(keyMove('2100-12-31', 'ArrowDown')).toBe('2100-12-31');
    expect(keyMove('2100-12-15', 'PageDown', { shift: true })).toBe('2100-12-31');
    expect(keyMove('2026-09-29', 'Enter')).toBeNull();
    expect(keyMove('2026-09-29', 'a')).toBeNull();
    expect([...CALENDAR_KEYS]).toHaveLength(8);
  });
});

describe('calendar words', () => {
  it('names days and months in full, Sunday first', () => {
    expect(calendarDayLabel('2026-09-01')).toBe('Tuesday, September 1, 2026');
    expect(calendarDayLabel('2026-11-01')).toBe('Sunday, November 1, 2026');
    expect(calendarMonthTitle({ y: 2026, m: 9 })).toBe('September 2026');
    expect([...CALENDAR_WEEKDAYS_SHORT]).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(CALENDAR_WEEKDAYS_LONG[0]).toBe('Sunday');
    expect(CALENDAR_COPY).toEqual({
      previousMonth: 'Previous month',
      nextMonth: 'Next month',
      startDate: 'Start date',
      endDate: 'End date',
      chooseStartDate: 'Choose a start date',
      chooseEndDate: 'Choose an end date',
    });
  });
  it('today is the answer’s org-local day, never the device clock', () => {
    expect(calendarToday('2026-09-29 23:58')).toBe('2026-09-29');
    expect(calendarToday(null)).toBeNull();
    expect(calendarToday(undefined)).toBeNull();
    expect(calendarToday('soon')).toBeNull();
    expect(isCalendarDay('2026-09-29')).toBe(true);
    expect(isCalendarDay('2101-01-01')).toBe(false);
  });
});

describe('source guard', () => {
  it('report-calendar.ts never builds a platform date or asks for locale names', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-calendar.ts');
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bDate\b/);
    expect(code).not.toMatch(/\bIntl\b/);
    expect(code).not.toMatch(/toLocale/);
    expect(code).not.toMatch(/getTimezoneOffset|process\.env/);
  });
});
