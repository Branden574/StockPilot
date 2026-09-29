import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EMPTY_CALENDAR_RANGE, rangePick, type CalendarRangeDraft } from '@stockpilot/core';

import { CALENDAR_CELL_MIN, monthCalendarView } from './month-calendar';

/**
 * The phone's month calendar (plan 5, D7), as data: 42 cells, Sunday first,
 * spoken day names, the range's look, the organization's today, and the
 * month buttons' bounds. The component draws exactly this view.
 */

const empty: CalendarRangeDraft = { ...EMPTY_CALENDAR_RANGE };

describe('monthCalendarView', () => {
  it("always 6 rows of 7 (42 cells), Sunday first, only the month's own days", () => {
    const v = monthCalendarView({ y: 2026, m: 9 }, empty, null);
    expect(v.title).toBe('September 2026');
    expect(v.weeks).toHaveLength(6);
    expect(v.weeks.every((w) => w.length === 7)).toBe(true);
    const days = v.weeks.flat().filter((d) => d !== null);
    expect(days).toHaveLength(30);
    // September 1, 2026 is a Tuesday: two empty cells before it.
    expect(v.weeks[0]!.slice(0, 3).map((d) => d?.text ?? null)).toEqual([null, null, '1']);
    expect(v.weekdays.map((d) => d.short)).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(v.weekdays[0]!.long).toBe('Sunday');
  });

  it('February 2026 starts on a Sunday and keeps the six rows (the grid never changes height)', () => {
    const v = monthCalendarView({ y: 2026, m: 2 }, empty, null);
    expect(v.weeks[0]![0]!.ymd).toBe('2026-02-01');
    expect(v.weeks).toHaveLength(6);
    expect(v.weeks.flat().filter(Boolean)).toHaveLength(28);
  });

  it('each day is named in full for VoiceOver; a daylight-saving day is an ordinary cell', () => {
    const v = monthCalendarView({ y: 2026, m: 3 }, empty, null);
    const mar8 = v.weeks.flat().find((d) => d?.ymd === '2026-03-08')!;
    expect(mar8.label).toBe('Sunday, March 8, 2026');
    expect(mar8.text).toBe('8');
    expect(mar8.hint).toBeNull();
  });

  it('the start and end are selected and say so, the days between are the band, today is marked', () => {
    let draft = rangePick(empty, '2026-09-01');
    draft = rangePick(draft, '2026-09-30');
    const v = monthCalendarView({ y: 2026, m: 9 }, draft, '2026-09-29');
    const day = (ymd: string) => v.weeks.flat().find((d) => d?.ymd === ymd)!;
    expect(day('2026-09-01')).toMatchObject({ selected: true, inRange: false, hint: 'Start date' });
    expect(day('2026-09-30')).toMatchObject({ selected: true, inRange: false, hint: 'End date' });
    expect(day('2026-09-15')).toMatchObject({ selected: false, inRange: true, hint: null });
    expect(day('2026-09-29')).toMatchObject({ inRange: true, isToday: true, hint: 'Today' });
    // A one-day range: the one day is both ends.
    const one = rangePick(rangePick(empty, '2026-09-10'), '2026-09-10');
    const w = monthCalendarView({ y: 2026, m: 9 }, one, null);
    expect(w.weeks.flat().find((d) => d?.ymd === '2026-09-10')!.hint).toBe('Start date. End date');
  });

  it("no answer, no today: the phone's clock is never used to mark a day", () => {
    const v = monthCalendarView({ y: 2026, m: 9 }, empty, null);
    expect(v.weeks.flat().some((d) => d?.isToday)).toBe(false);
  });

  it('Previous month and Next month stop at 2000-01 and 2100-12 (the SQL bounds)', () => {
    const first = monthCalendarView({ y: 2000, m: 1 }, empty, null);
    expect(first.previous).toMatchObject({ label: 'Previous month', enabled: false });
    expect(first.next).toMatchObject({
      label: 'Next month',
      enabled: true,
      month: { y: 2000, m: 2 },
    });
    const last = monthCalendarView({ y: 2100, m: 12 }, empty, null);
    expect(last.next.enabled).toBe(false);
    expect(monthCalendarView({ y: 2026, m: 1 }, empty, null).previous.month).toEqual({
      y: 2025,
      m: 12,
    });
  });

  it('every day and month button is at least a 44 pt target', () => {
    expect(CALENDAR_CELL_MIN).toBeGreaterThanOrEqual(44);
  });

  it("builds no Date and asks no Intl (Hermes, and the organization's zone)", () => {
    for (const rel of ['month-calendar.ts', '../components/ui/month-calendar.tsx']) {
      const src = readFileSync(path.join(__dirname, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, rel).not.toMatch(/\bnew Date\b|\bDate\.|\bIntl\b|toLocale/);
    }
  });
});
