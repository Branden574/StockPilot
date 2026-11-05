import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isDesktopViewport, subscribeToDesktopViewport } from '@/components/dashboard/sidebar-pref';

import {
  CLASSIC_DESKTOP_QUERY,
  GLASS_DESKTOP_QUERY,
  desktopViewportQuery,
  subscribeToDesktopViewportQueries,
} from './glass-viewport';

/**
 * The dashboard's desktop width by the Design on screen (Liquid Glass stage 3):
 * 768 px in classic, 761 px in glass, where shell.css already shows the pinned
 * sidebar. The sidebar control must agree with what is drawn, so in the
 * 761-767 px band it collapses the sidebar in glass and opens the phone sheet
 * in classic. Under the `off` rollout nothing but today's query is listened to.
 */

/** A matchMedia over a fixed window width that records its listeners. */
function fakeMatchMedia(width: number) {
  const listeners = new Map<string, Set<() => void>>();
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const min = Number(/min-width:\s*(\d+)px/u.exec(query)?.[1] ?? 0);
    const set = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, set);
    return {
      matches: width >= min,
      media: query,
      addEventListener: (_: string, l: () => void) => set.add(l),
      removeEventListener: (_: string, l: () => void) => set.delete(l),
    } as unknown as MediaQueryList;
  });
  return { spy, listeners };
}

const showGlass = () => document.documentElement.setAttribute('data-appearance', 'liquid-glass');

beforeEach(() => {
  document.documentElement.removeAttribute('data-appearance');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-appearance');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('desktopViewportQuery', () => {
  it('is Tailwind md (768 px) in classic and 761 px while Liquid Glass is on screen', () => {
    expect(desktopViewportQuery()).toBe(CLASSIC_DESKTOP_QUERY);
    expect(CLASSIC_DESKTOP_QUERY).toBe('(min-width: 768px)');
    showGlass();
    expect(desktopViewportQuery()).toBe(GLASS_DESKTOP_QUERY);
    expect(GLASS_DESKTOP_QUERY).toBe('(min-width: 761px)');
  });
});

describe('isDesktopViewport in the 761-767 px band', () => {
  it('765 px: a phone in classic, a desktop in glass; 760 px is a phone in both', () => {
    fakeMatchMedia(765);
    expect(isDesktopViewport()).toBe(false);
    showGlass();
    expect(isDesktopViewport()).toBe(true);
    vi.restoreAllMocks();
    fakeMatchMedia(760);
    expect(isDesktopViewport()).toBe(false);
  });

  it('768 px and up is a desktop in both', () => {
    fakeMatchMedia(768);
    expect(isDesktopViewport()).toBe(true);
    showGlass();
    expect(isDesktopViewport()).toBe(true);
  });
});

describe('subscribeToDesktopViewport', () => {
  it('under the off rollout listens to the classic query only, as before', () => {
    const { listeners } = fakeMatchMedia(1024);
    const onChange = vi.fn();
    const off = subscribeToDesktopViewport(onChange);
    expect([...listeners.keys()]).toEqual([CLASSIC_DESKTOP_QUERY]);
    expect(listeners.get(CLASSIC_DESKTOP_QUERY)!.size).toBe(1);
    off();
    expect(listeners.get(CLASSIC_DESKTOP_QUERY)!.size).toBe(0);
  });

  it('with Liquid Glass in the build, a crossing of either width or a Design switch notifies, and the unsubscribe removes all three', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { listeners } = fakeMatchMedia(1024);
    const onChange = vi.fn();
    const off = subscribeToDesktopViewportQueries(onChange);
    expect([...listeners.keys()].sort()).toEqual(
      [CLASSIC_DESKTOP_QUERY, GLASS_DESKTOP_QUERY].sort(),
    );
    for (const l of listeners.get(GLASS_DESKTOP_QUERY)!) l();
    expect(onChange).toHaveBeenCalledTimes(1);
    showGlass();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalledTimes(2);
    off();
    expect(listeners.get(CLASSIC_DESKTOP_QUERY)!.size).toBe(0);
    expect(listeners.get(GLASS_DESKTOP_QUERY)!.size).toBe(0);
    document.documentElement.removeAttribute('data-appearance');
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
