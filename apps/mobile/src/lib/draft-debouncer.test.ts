import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraftDebouncer } from './draft-debouncer';

/**
 * A count typed within the debounce window of leaving the count screen used
 * to be dropped: the unmount cleanup CLEARED the timers, so updateLocalLine
 * (the local write and the outbox row) never ran for the last edit.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDraftDebouncer', () => {
  it('saves the latest value once typing pauses', () => {
    const persist = vi.fn();
    const saver = createDraftDebouncer(300, persist);
    saver.schedule('l1', '1');
    saver.schedule('l1', '12');
    vi.advanceTimersByTime(299);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persist).toHaveBeenCalledExactlyOnceWith('l1', '12');
  });

  it('flushAll SAVES what is still pending (leaving the screen) instead of dropping it', () => {
    const persist = vi.fn();
    const saver = createDraftDebouncer(300, persist);
    saver.schedule('l1', '7');
    saver.schedule('l2', '3');
    vi.advanceTimersByTime(100); // tapped Back 100 ms after the last keystroke

    saver.flushAll();

    expect(persist.mock.calls).toEqual([
      ['l1', '7'],
      ['l2', '3'],
    ]);
  });

  it('a flushed value is not saved a second time when its old timer would have fired', () => {
    const persist = vi.fn();
    const saver = createDraftDebouncer(300, persist);
    saver.schedule('l1', '7');
    saver.flushAll();
    vi.advanceTimersByTime(1000);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushAll with nothing pending saves nothing (already-saved lines are not re-saved)', () => {
    const persist = vi.fn();
    const saver = createDraftDebouncer(300, persist);
    saver.schedule('l1', '7');
    vi.advanceTimersByTime(300);
    saver.flushAll();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('the count screen flushes on unmount (wiring)', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/cycle-count/[id].tsx'), 'utf8');

  it('schedules each keystroke through the debouncer and flushes it in the unmount cleanup', () => {
    expect(screen).toContain('createDraftDebouncer(SAVE_DEBOUNCE_MS,');
    expect(screen).toContain('lineSaver.schedule(lineId, v);');
    expect(screen).toMatch(
      /React\.useEffect\(\(\) => \{\s+return \(\) => lineSaver\.flushAll\(\);\s+\}, \[lineSaver\]\);/,
    );
    // The save it flushes is the real one: the local write + outbox row.
    expect(screen).toMatch(
      /createDraftDebouncer\(SAVE_DEBOUNCE_MS,[\s\S]*?await updateLocalLine\(lineId, num\);/,
    );
  });

  it('no longer cancels pending saves by clearing their timers', () => {
    expect(screen).not.toContain('debounceRefs');
    expect(screen).not.toMatch(/clearTimeout\(/);
  });
});
