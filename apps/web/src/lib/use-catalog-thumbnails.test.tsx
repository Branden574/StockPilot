// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCatalogPages, useCatalogThumbnails } from './use-catalog-thumbnails';

const URLS = { 'item-1': 'https://signed/thumb1.webp' };

function okResponse() {
  return { ok: true, json: async () => ({ urls: URLS }) } as Response;
}
function failResponse() {
  return { ok: false, json: async () => ({}) } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useCatalogThumbnails', () => {
  it('loads thumbnail urls on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    const { result } = renderHook(() => useCatalogThumbnails('/api/thumbs'));
    await vi.waitFor(() => {
      expect(result.current).toEqual(URLS);
    });
  });

  // The audit finding: a single failed fetch used to blank the whole
  // session. The hook must retry and recover.
  it('retries with backoff after a failure and recovers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failResponse()) // first attempt: 429/500
      .mockResolvedValueOnce(okResponse()); // retry succeeds
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCatalogThumbnails('/api/thumbs'));

    // first attempt fails
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(result.current).toEqual({});

    // advance past the 2s backoff → retry fires and succeeds
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current).toEqual(URLS);
    });
  });

  it('gives up after the retry budget instead of looping forever', async () => {
    const fetchMock = vi.fn(async () => failResponse());
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCatalogThumbnails('/api/thumbs'));
    // initial + 3 retries at 2s/4s/8s
    await vi.advanceTimersByTimeAsync(20000);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('re-fires when the browser comes back online', async () => {
    const fetchMock = vi.fn(async () => failResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCatalogThumbnails('/api/thumbs'));
    await vi.advanceTimersByTimeAsync(20000); // exhaust retries
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    fetchMock.mockResolvedValue(okResponse());
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(result.current).toEqual(URLS);
    });
  });

  it('does nothing for a null url', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCatalogThumbnails(null));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The public request page's photo pages (B32, integrator decision 1): the
 * route answers at most 500 items per request with the URL of the next page,
 * and the hook reads every page, so an item past the 500th still gets its
 * photo, blur and description. The staff rental form's route answers one page
 * with no `next`, and nothing changes for it.
 */
describe('useCatalogPages', () => {
  type Page = {
    urls?: Record<string, string>;
    lqip?: Record<string, string>;
    descriptions?: Record<string, string>;
    next?: unknown;
  };
  const pageResponse = (p: Page) => ({ ok: true, json: async () => p }) as Response;

  /** A fetch that answers each URL from `pages`, or fails it when `fail` says. */
  function served(
    pages: Record<string, Page>,
    fail: (url: string, n: number) => boolean = () => false,
  ) {
    const asked: string[] = [];
    const fn = vi.fn(async (url: string) => {
      asked.push(url);
      if (fail(url, asked.filter((u) => u === url).length)) return failResponse();
      const p = pages[url];
      return p ? pageResponse(p) : failResponse();
    });
    vi.stubGlobal('fetch', fn);
    return { asked, fn };
  }

  // Mutation caught: a hook that reads the first page only (the old one).
  it('reads every page the answers name, in order, and merges what each carries', async () => {
    const { asked } = served({
      '/p0': { urls: { a: 'u-a' }, lqip: { a: 'b-a' }, descriptions: { a: 'd-a' }, next: '/p1' },
      '/p1': { urls: { b: 'u-b' }, descriptions: { b: 'd-b' }, next: '/p2' },
      '/p2': { urls: { c: 'u-c' }, lqip: { c: 'b-c' }, next: null },
    });
    const { result } = renderHook(() => useCatalogPages('/p0'));
    await vi.waitFor(() => {
      expect(result.current.urls).toEqual({ a: 'u-a', b: 'u-b', c: 'u-c' });
    });
    expect(result.current.lqip).toEqual({ a: 'b-a', c: 'b-c' });
    expect(result.current.descriptions).toEqual({ a: 'd-a', b: 'd-b' });
    expect(asked).toEqual(['/p0', '/p1', '/p2']);
  });

  it('a failed later page keeps the pages already read, retries with backoff, then goes on', async () => {
    const { asked } = served(
      {
        '/p0': { urls: { a: 'u-a' }, next: '/p1' },
        '/p1': { urls: { b: 'u-b' }, next: '/p2' },
        '/p2': { urls: { c: 'u-c' }, next: null },
      },
      (url, n) => url === '/p1' && n === 1,
    );
    const { result } = renderHook(() => useCatalogPages('/p0'));
    await vi.waitFor(() => {
      expect(asked).toEqual(['/p0', '/p1']);
    });
    expect(result.current.urls).toEqual({ a: 'u-a' });
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => {
      expect(result.current.urls).toEqual({ a: 'u-a', b: 'u-b', c: 'u-c' });
    });
    expect(asked).toEqual(['/p0', '/p1', '/p1', '/p2']);
  });

  it('back online after a page ran out of retries, it starts again at that page, not the first', async () => {
    let down = true;
    const { asked } = served(
      { '/p0': { urls: { a: 'u-a' }, next: '/p1' }, '/p1': { urls: { b: 'u-b' }, next: null } },
      (url) => url === '/p1' && down,
    );
    const { result } = renderHook(() => useCatalogPages('/p0'));
    await vi.advanceTimersByTimeAsync(20000); // the first page, then /p1 four times
    await vi.waitFor(() => {
      expect(asked).toEqual(['/p0', '/p1', '/p1', '/p1', '/p1']);
    });
    down = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(result.current.urls).toEqual({ a: 'u-a', b: 'u-b' });
    });
    expect(asked.slice(5)).toEqual(['/p1']);
  });

  it('once every page is read, coming back online asks for nothing', async () => {
    const { asked } = served({ '/p0': { urls: { a: 'u-a' }, next: null } });
    const { result } = renderHook(() => useCatalogPages('/p0'));
    await vi.waitFor(() => {
      expect(result.current.urls).toEqual({ a: 'u-a' });
    });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toEqual(['/p0']);
  });

  // A page that names itself, or another site, is not followed.
  it('never reads a page twice, and never follows a next that is not a path on this site', async () => {
    const { asked } = served({
      '/p0': { urls: { a: 'u-a' }, next: '/p1' },
      '/p1': { urls: { b: 'u-b' }, next: '/p0' },
    });
    const first = renderHook(() => useCatalogPages('/p0'));
    await vi.waitFor(() => {
      expect(first.result.current.urls).toEqual({ a: 'u-a', b: 'u-b' });
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toEqual(['/p0', '/p1']);
    first.unmount();

    for (const next of ['https://elsewhere.example/p', '//elsewhere.example/p', 42, 'p1']) {
      const run = served({ '/p0': { urls: { a: 'u-a' }, next } });
      const { result, unmount } = renderHook(() => useCatalogPages('/p0'));
      await vi.waitFor(() => {
        expect(result.current.urls).toEqual({ a: 'u-a' });
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(run.asked).toEqual(['/p0']);
      unmount();
    }
  });

  it('stops after 20 pages whatever the answers say', async () => {
    const pages: Record<string, Page> = {};
    for (let i = 0; i < 30; i += 1)
      pages[`/p${i}`] = { urls: { [`i${i}`]: 'u' }, next: `/p${i + 1}` };
    const { asked } = served(pages);
    renderHook(() => useCatalogPages('/p0'));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(20);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toHaveLength(20);
  });

  it('useCatalogThumbnails still answers the photo map of a one-page route', async () => {
    served({ '/thumbs': { urls: { a: 'u-a' } } });
    const { result } = renderHook(() => useCatalogThumbnails('/thumbs'));
    await vi.waitFor(() => {
      expect(result.current).toEqual({ a: 'u-a' });
    });
  });
});
