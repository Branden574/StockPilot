import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dayPartAt, homeGreeting, nextDayPartChange } from './greeting';

/**
 * THE HOME SCREEN'S GREETING (walk 2026-09-28/29).
 *
 * Home said "Good morning," at every hour: the words were written into the
 * screen. The greeting now follows the phone's own clock: morning before
 * 12:00, afternoon before 17:00 (5 PM), evening from 17:00 to midnight.
 * Dates are built from local parts, so these read the same in any time zone
 * the suite runs in.
 */

const at = (h: number, m: number) => new Date(2026, 8, 29, h, m, 0, 0);

describe('dayPartAt: the part of the day on the phone', () => {
  it.each([
    [0, 0, 'morning'],
    [4, 59, 'morning'],
    [5, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'afternoon'],
    [16, 59, 'afternoon'],
    [17, 0, 'evening'],
    [23, 59, 'evening'],
  ] as const)('%i:%i is %s', (h, m, part) => {
    expect(dayPartAt(at(h, m))).toBe(part);
  });

  it('the last second before noon and before 5 PM still count as the earlier part', () => {
    expect(dayPartAt(new Date(2026, 8, 29, 11, 59, 59, 999))).toBe('morning');
    expect(dayPartAt(new Date(2026, 8, 29, 16, 59, 59, 999))).toBe('afternoon');
  });
});

describe('homeGreeting: the words Home shows', () => {
  it('says good morning, afternoon or evening, with the comma the name follows', () => {
    expect(homeGreeting(at(9, 30))).toBe('Good morning,');
    expect(homeGreeting(at(12, 0))).toBe('Good afternoon,');
    expect(homeGreeting(at(17, 0))).toBe('Good evening,');
  });
});

describe('nextDayPartChange: when the greeting or the date line next changes', () => {
  // Noon, 5 PM and midnight (the greeting at the first two, the date line at
  // midnight, when the greeting also turns to morning).
  it.each([
    [[0, 0, 0], [2026, 8, 29, 12]],
    [[9, 30, 0], [2026, 8, 29, 12]],
    [[11, 59, 59], [2026, 8, 29, 12]],
    [[12, 0, 0], [2026, 8, 29, 17]],
    [[16, 59, 59], [2026, 8, 29, 17]],
    [[17, 0, 0], [2026, 8, 30, 0]],
    [[23, 59, 59], [2026, 8, 30, 0]],
  ] as const)('from %j the next change is %j', ([h, m, sec], [y, mo, d, nh]) => {
    const from = new Date(2026, 8, 29, h, m, sec, 0);
    expect(nextDayPartChange(from).getTime()).toBe(new Date(y, mo, d, nh, 0, 0, 0).getTime());
    expect(nextDayPartChange(from).getTime()).toBeGreaterThan(from.getTime());
  });

  it('crosses the end of a month and a year', () => {
    expect(nextDayPartChange(new Date(2026, 11, 31, 20, 0)).getTime()).toBe(new Date(2027, 0, 1, 0, 0).getTime());
  });

  it('the part of the day at the change is the next one', () => {
    for (const from of [at(8, 0), at(13, 0), at(21, 0)]) {
      const next = nextDayPartChange(from);
      const after = new Date(next.getTime() + 1);
      const before = new Date(next.getTime() - 1);
      const changed = dayPartAt(after) !== dayPartAt(before) || after.getDate() !== before.getDate();
      expect(changed).toBe(true);
    }
  });
});

describe('Home reads the clock, and reads it again when it comes back', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/(drawer)/(tabs)/index.tsx'),
    'utf8',
  );

  // Mutation caught: the greeting written back into the screen.
  it('the greeting comes from homeGreeting, never written into the screen', () => {
    expect(src).not.toMatch(/Good (morning|afternoon|evening)/);
    expect(src).toContain('{homeGreeting(now)}');
  });

  // Home stays mounted behind the other tabs, so a clock read once at mount
  // would keep the morning's greeting all day. Mutation caught: either
  // refresh removed.
  it('the clock is read again on focus and when the app comes back to the foreground', () => {
    expect(src).toContain('const [now, setNow] = React.useState(() => new Date());');
    expect(src).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \{[\s\S]{0,200}?const readClock = \(\) => \{\s*const current = new Date\(\);\s*setNow\(current\);/);
    expect(src).toMatch(/AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active'\) setNow\(new Date\(\)\);/);
    // The date line reads the same clock as the greeting.
    expect(src).not.toMatch(/const now = new Date\(\);/);
  });

  // Review of 2026-09-29: a Home screen left open (a shared tablet that never
  // goes to the background) kept "Good morning" and yesterday's date, even
  // after a pull to refresh. Mutation caught: the timer or its clean-up
  // dropped, or Refresh not reading the clock.
  it('while Home is open the clock is read again at noon, 5 PM and midnight, and on Refresh', () => {
    const focus = /useFocusEffect\(\s*React\.useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\),\s*\);/.exec(src)?.[1] ?? '';
    expect(focus).toMatch(/timer = setTimeout\(readClock, nextDayPartChange\(current\)\.getTime\(\) - current\.getTime\(\) \+ \d+\);/);
    expect(focus).toMatch(/readClock\(\);\s*return \(\) => clearTimeout\(timer\);/);
    expect(src).toMatch(/async function onRefresh\(\) \{\s*setNow\(new Date\(\)\);/);
  });
});
