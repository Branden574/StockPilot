// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCatalogThumbnails } from './use-catalog-thumbnails';

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
