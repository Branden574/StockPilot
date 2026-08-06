import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncedScheduler, createSequenceGuard } from './debounced-list-load';

describe('createDebouncedScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('typing N characters quickly results in ONE call, not N', () => {
    const scheduler = createDebouncedScheduler(250);
    const fn = vi.fn();

    // Simulates a search box firing schedule() on every keystroke, each one
    // arriving before the previous delay elapses — the exact shape of typing
    // a word fast on a phone keyboard.
    for (const ms of [0, 40, 80, 120, 160]) {
      vi.advanceTimersByTime(ms === 0 ? 0 : 40);
      scheduler.schedule(fn);
    }

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs again for a call made after the delay has fully elapsed', () => {
    const scheduler = createDebouncedScheduler(250);
    const fn = vi.fn();

    scheduler.schedule(fn);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);

    scheduler.schedule(fn);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs the LATEST scheduled function, not an earlier one', () => {
    const scheduler = createDebouncedScheduler(250);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule(first);
    vi.advanceTimersByTime(100);
    scheduler.schedule(second);
    vi.advanceTimersByTime(250);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel() stops a pending call from ever firing', () => {
    const scheduler = createDebouncedScheduler(250);
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() with nothing pending is a no-op, not a throw', () => {
    const scheduler = createDebouncedScheduler(250);
    expect(() => scheduler.cancel()).not.toThrow();
  });
});

describe('createSequenceGuard', () => {
  it('the first token is current until a second call starts', () => {
    const guard = createSequenceGuard();
    const token = guard.next();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('starting a newer call invalidates the older token', () => {
    const guard = createSequenceGuard();
    const older = guard.next();
    const newer = guard.next();

    expect(guard.isCurrent(older)).toBe(false);
    expect(guard.isCurrent(newer)).toBe(true);
  });

  it('an out-of-order stale response does not win: the older token stays stale even after the newer one resolves', async () => {
    const guard = createSequenceGuard();
    const rows: string[] = [];

    // Simulates the exact race the mobile screen guards against: a slow
    // response for an EARLIER keystroke lands AFTER a fast response for a
    // LATER one. Two in-flight "requests" are represented as promises that
    // resolve out of order (the older one resolves last).
    async function load(token: number, resolveAfterMs: number, resultRows: string[]) {
      await new Promise((resolve) => setTimeout(resolve, resolveAfterMs));
      if (!guard.isCurrent(token)) return; // stale — must not replace newer rows
      rows.length = 0;
      rows.push(...resultRows);
    }

    const olderToken = guard.next(); // e.g. query "br" — slow network
    const olderLoad = load(olderToken, 30, ['stale-result-for-br']);

    const newerToken = guard.next(); // e.g. query "broken" — fast network
    const newerLoad = load(newerToken, 5, ['fresh-result-for-broken']);

    await Promise.all([newerLoad, olderLoad]);

    // The newer, faster response applied its rows...
    expect(rows).toEqual(['fresh-result-for-broken']);
    // ...and the older, slower response — even though it resolved LAST —
    // must never have been allowed to overwrite them.
    expect(rows).not.toContain('stale-result-for-br');
  });

  it('each next() token is unique and strictly increasing', () => {
    const guard = createSequenceGuard();
    const a = guard.next();
    const b = guard.next();
    const c = guard.next();

    expect(new Set([a, b, c]).size).toBe(3);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
