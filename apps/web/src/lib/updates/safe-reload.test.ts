// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { judgeReload, reconcileReload, reloadToBuild, tidyReloadUrl } from './safe-reload';

const replace = vi.fn();
let href = 'https://stockpilotusa.com/dashboard/inventory?status=active';

beforeEach(() => {
  sessionStorage.clear();
  replace.mockReset();
  href = 'https://stockpilotusa.com/dashboard/inventory?status=active';
  vi.stubGlobal('location', {
    get href() {
      return href;
    },
    replace,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('reloadToBuild', () => {
  it('requests a FRESH document for the same page, keeping the route and its query', () => {
    reloadToBuild('bbbbbbbbbbbb');
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URL(replace.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/dashboard/inventory');
    expect(url.searchParams.get('status')).toBe('active');
    expect(url.searchParams.get('_v')).toBeTruthy();
  });

  it('never clears Cache Storage, cookies or storage as a blanket strategy', () => {
    const del = vi.fn();
    vi.stubGlobal('caches', { keys: vi.fn(async () => ['x']), delete: del });
    localStorage.setItem('keep', '1');
    reloadToBuild('bbbbbbbbbbbb');
    expect(del).not.toHaveBeenCalled();
    expect(localStorage.getItem('keep')).toBe('1');
  });

  it('still reloads when storage is unavailable', () => {
    // Stubbed whole: happy-dom's storage does not go through Storage.prototype,
    // so a prototype spy never fires and this would pass without testing anything.
    const setItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem, removeItem: () => {} });
    reloadToBuild('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

describe('judgeReload', () => {
  it('asks whether the tab MOVED, not whether it hit the exact build it expected', () => {
    // A -> B as expected.
    expect(judgeReload({ target: 'b', from: 'a' }, 'b')).toBe('reached');
    // Production was promoted again between the last poll and the click: the
    // tab landed on C. That is a success, and it used to be reported as a miss.
    expect(judgeReload({ target: 'b', from: 'a' }, 'c')).toBe('reached');
    // The document came back from a cache: still on A.
    expect(judgeReload({ target: 'b', from: 'a' }, 'a')).toBe('not_reached');
    // A rollback the tab accepted.
    expect(judgeReload({ target: 'a', from: 'b' }, 'a')).toBe('reached');
  });

  it('falls back to the exact expectation when it never knew where it started', () => {
    expect(judgeReload({ target: 'b', from: null }, 'b')).toBe('reached');
    expect(judgeReload({ target: 'b', from: null }, 'c')).toBe('not_reached');
  });

  it('cannot confirm anything without a loaded identity', () => {
    expect(judgeReload({ target: 'b', from: 'a' }, '')).toBe('not_reached');
  });
});

describe('reconcileReload', () => {
  const replaceState = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    replaceState.mockReset();
    vi.stubGlobal('history', { state: { __NA: true, k: 1 }, replaceState });
  });
  afterEach(() => vi.useRealTimers());

  it('is none when no reload was asked for', () => {
    expect(reconcileReload('aaaaaaaaaaaa')).toBe('none');
  });

  it('confirms the reload moved the tab, and forgets it', () => {
    reloadToBuild('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
    expect(reconcileReload('bbbbbbbbbbbb')).toBe('reached');
    expect(reconcileReload('bbbbbbbbbbbb')).toBe('none');
  });

  it('counts landing on something NEWER than expected as reached', () => {
    reloadToBuild('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
    expect(reconcileReload('cccccccccccc')).toBe('reached');
  });

  it('reports a miss ONCE and never sets up a loop', () => {
    reloadToBuild('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
    expect(reconcileReload('aaaaaaaaaaaa')).toBe('not_reached');
    expect(reconcileReload('aaaaaaaaaaaa')).toBe('none');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('tidies the address bar a tick LATER, after Next has patched history', () => {
    href = 'https://stockpilotusa.com/dashboard/inventory?status=active&_v=abc123';
    reconcileReload('aaaaaaaaaaaa');
    expect(replaceState).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('survives corrupt storage', () => {
    sessionStorage.setItem('sp:update-target', '{not json');
    expect(reconcileReload('aaaaaaaaaaaa')).toBe('none');
  });
});

describe('tidyReloadUrl', () => {
  const replaceState = vi.fn();
  beforeEach(() => {
    replaceState.mockReset();
    vi.stubGlobal('history', { state: { __NA: true, k: 1 }, replaceState });
  });

  it('removes the cache-busting param, keeping everything else', () => {
    href = 'https://stockpilotusa.com/dashboard/inventory?status=active&_v=abc123';
    tidyReloadUrl();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]![2]).toBe(
      'https://stockpilotusa.com/dashboard/inventory?status=active',
    );
  });

  it("passes NULL state, never Next's own: Next skips its router sync for a state it recognises", () => {
    href = 'https://stockpilotusa.com/dashboard/inventory?_v=abc123';
    tidyReloadUrl();
    expect(replaceState.mock.calls[0]![0]).toBeNull();
  });

  it('touches nothing when there is no param to remove', () => {
    tidyReloadUrl();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
