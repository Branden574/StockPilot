import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./storefront-cards', () => ({}));

import type { CatalogItem } from '../v2/types';
import { toFreqEntries, useStreamed } from './frequently-ordered';

const item = (id: string, imageUrl: string | null): CatalogItem =>
  ({ id, name: `Item ${id}`, imageUrl }) as CatalogItem;

describe('toFreqEntries', () => {
  const catalog = new Map([
    ['a', item('a', 'catalog-a')],
    ['b', item('b', null)],
  ]);

  it('takes the row from the catalog, in the ranking order, and drops ids the catalog does not hold', () => {
    const out = toFreqEntries(
      [
        { itemId: 'b', count: 9, fallbackImageUrl: null },
        { itemId: 'gone', count: 5, fallbackImageUrl: null },
        { itemId: 'a', count: 2, fallbackImageUrl: null },
      ],
      catalog,
    );
    expect(out.map((e) => [e.item.id, e.count])).toEqual([
      ['b', 9],
      ['a', 2],
    ]);
    expect(out[1]!.item.name).toBe('Item a');
  });

  it('uses the fallback photo ONLY when the catalog row has none', () => {
    const out = toFreqEntries(
      [
        { itemId: 'a', count: 1, fallbackImageUrl: 'fallback-a' },
        { itemId: 'b', count: 1, fallbackImageUrl: 'fallback-b' },
      ],
      catalog,
    );
    expect(out[0]!.item.imageUrl).toBe('catalog-a');
    expect(out[1]!.item.imageUrl).toBe('fallback-b');
    // The catalog's own row is not modified.
    expect(catalog.get('b')!.imageUrl).toBeNull();
  });
});

describe('useStreamed', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it('is null until the promise settles, then the value, and never suspends', async () => {
    const d = deferred<string[]>();
    const { result } = renderHook(({ p }) => useStreamed(p), { initialProps: { p: d.promise } });
    expect(result.current).toBeNull();
    await act(async () => d.resolve(['x']));
    expect(result.current).toEqual(['x']);
  });

  it('a NEW promise shows nothing of the old one while it is pending', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(({ p }) => useStreamed(p), {
      initialProps: { p: first.promise },
    });
    await act(async () => first.resolve('warehouse one'));
    expect(result.current).toBe('warehouse one');
    rerender({ p: second.promise });
    expect(result.current).toBeNull();
    await act(async () => second.resolve('warehouse two'));
    expect(result.current).toBe('warehouse two');
  });

  it('ignores an old promise that settles after it was replaced', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(({ p }) => useStreamed(p), {
      initialProps: { p: first.promise },
    });
    rerender({ p: second.promise });
    await act(async () => second.resolve('current'));
    await act(async () => first.resolve('stale'));
    expect(result.current).toBe('current');
  });

  it('a rejection leaves it null and is not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const d = deferred<string>();
    const { result } = renderHook(({ p }) => useStreamed(p), { initialProps: { p: d.promise } });
    await act(async () => {
      d.reject(new Error('nope'));
      await new Promise((r) => setTimeout(r, 10));
    });
    process.off('unhandledRejection', unhandled);
    expect(result.current).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
