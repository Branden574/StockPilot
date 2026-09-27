import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { settledOutcome, useSettled, watchSettled } from './settled-promise';

// The New order page reads its streamed kits without waiting for them: Submit
// for the audit note, a category or search view for its kit cards (walk
// 2026-09-27: Submit sat on the kits read for 6.3 s, and a search changed
// nothing on screen while the read was out).

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('watchSettled / settledOutcome', () => {
  it('reads nothing while the promise is out, then what it came to', async () => {
    const d = deferred<string>();
    watchSettled(d.promise);
    expect(settledOutcome(d.promise)).toBeUndefined();
    d.resolve('kits');
    await d.promise;
    expect(settledOutcome(d.promise)).toEqual({ ok: true, value: 'kits' });
  });

  it('a rejection is recorded as not ok, and is not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const d = deferred<string>();
    watchSettled(d.promise);
    d.reject(new Error('stream closed'));
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(settledOutcome(d.promise)).toEqual({ ok: false });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('a promise nobody watched reads as not settled, even once it has', async () => {
    const p = Promise.resolve('kits');
    await p;
    expect(settledOutcome(p)).toBeUndefined();
  });
});

describe('useSettled', () => {
  it('never suspends: pending reads as undefined, and the caller re-renders once it settles', async () => {
    const d = deferred<string>();
    const { result } = renderHook(({ p }) => useSettled(p), { initialProps: { p: d.promise } });
    expect(result.current).toBeUndefined();
    await act(async () => d.resolve('kits'));
    expect(result.current).toEqual({ ok: true, value: 'kits' });
  });

  it('a promise already watched and settled reads at once, on the first render', async () => {
    const p = Promise.resolve('kits');
    watchSettled(p);
    await p;
    await Promise.resolve();
    const { result } = renderHook(() => useSettled(p));
    expect(result.current).toEqual({ ok: true, value: 'kits' });
  });

  it('a rejection re-renders the caller with not ok', async () => {
    const d = deferred<string>();
    const { result } = renderHook(({ p }) => useSettled(p), { initialProps: { p: d.promise } });
    await act(async () => {
      d.reject(new Error('stream closed'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toEqual({ ok: false });
  });

  it('a NEW promise reads as its own, never the old one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(({ p }) => useSettled(p), {
      initialProps: { p: first.promise },
    });
    await act(async () => first.resolve('one warehouse'));
    rerender({ p: second.promise });
    expect(result.current).toBeUndefined();
    await act(async () => second.resolve('the other'));
    expect(result.current).toEqual({ ok: true, value: 'the other' });
  });
});
