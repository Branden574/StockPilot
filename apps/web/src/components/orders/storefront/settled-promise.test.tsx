import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
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

/**
 * Review 2026-09-27: the hook read the outcome in render, and its effect
 * returned early when the outcome was already recorded, without re-rendering.
 * When the promise settled after the render but before the effect ran (someone
 * opens a category just as the kits arrive), the view kept the stale "pending"
 * answer: no kit cards, and "Checking the kits..." with no items to show.
 *
 * act() flushes a commit and its effects in one synchronous pass, so it cannot
 * open that window; this test uses a plain root, where React runs the passive
 * effects in a later task and the promise's callbacks run in between. The
 * sibling settles the promise in its layout effect, i.e. after the reader has
 * rendered and before the reader's effect.
 */
describe('useSettled, when the promise settles between render and effect', () => {
  it('re-renders with the outcome instead of staying pending', async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      const d = deferred<string>();
      // The page watches the kits promise before any view reads it.
      watchSettled(d.promise);
      const seen: string[] = [];
      function Reader({ p }: { p: Promise<string> }) {
        const outcome = useSettled(p);
        const text = outcome === undefined ? 'pending' : outcome.ok ? outcome.value : 'failed';
        seen.push(text);
        return <span data-testid="reader">{text}</span>;
      }
      function SettlesInLayoutEffect({ settle }: { settle: () => void }) {
        React.useLayoutEffect(settle, [settle]);
        return null;
      }
      const settle = () => d.resolve('kits');
      root.render(
        <>
          <Reader p={d.promise} />
          <SettlesInLayoutEffect settle={settle} />
        </>,
      );
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      // Let the commit, the promise callbacks and the passive effects all run.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen[0]).toBe('pending');
      expect(settledOutcome(d.promise)).toEqual({ ok: true, value: 'kits' });
      expect(container.textContent).toBe('kits');
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    }
  });

  it('a rejection in that window re-renders with not ok', async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      const d = deferred<string>();
      watchSettled(d.promise);
      function Reader({ p }: { p: Promise<string> }) {
        const outcome = useSettled(p);
        return (
          <span>{outcome === undefined ? 'pending' : outcome.ok ? outcome.value : 'failed'}</span>
        );
      }
      function SettlesInLayoutEffect({ settle }: { settle: () => void }) {
        React.useLayoutEffect(settle, [settle]);
        return null;
      }
      const settle = () => d.reject(new Error('stream closed'));
      root.render(
        <>
          <Reader p={d.promise} />
          <SettlesInLayoutEffect settle={settle} />
        </>,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(settledOutcome(d.promise)).toEqual({ ok: false });
      expect(container.textContent).toBe('failed');
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    }
  });
});
