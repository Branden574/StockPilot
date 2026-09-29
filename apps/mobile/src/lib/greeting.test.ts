import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dayPartAt, homeGreeting } from './greeting';

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
    expect(src).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*setNow\(new Date\(\)\);/);
    expect(src).toMatch(/AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active'\) setNow\(new Date\(\)\);/);
    // The date line reads the same clock as the greeting.
    expect(src).not.toMatch(/const now = new Date\(\);/);
  });
});
