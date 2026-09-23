// @vitest-environment happy-dom
// The store reads window.location and listens for `pageshow`; under the node
// project's environment it would return early and every test here would pass
// without exercising anything. The first test fails loudly if this is lost.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRouterNavigation,
  MAX_PENDING_NAVIGATION_MS,
  noteCommittedLocation,
  noteLateSkeleton,
  pendingPathNavigationRemaining,
  recordRouterTransitionStart,
  REDIRECT_FOLLOW_MS,
  resetRouterNavigationForTests,
  subscribeRouterNavigation,
  type RouterNavigation,
} from './router-navigation';

const ORIGIN = window.location.origin;

function nav(): RouterNavigation {
  const snapshot = getRouterNavigation();
  if (!snapshot) throw new Error('no navigation recorded');
  return snapshot;
}

beforeEach(() => {
  resetRouterNavigationForTests();
  window.history.replaceState(null, '', '/dashboard/inventory');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordRouterTransitionStart', () => {
  it('runs with a DOM (the happy-dom docblock is in place)', () => {
    expect(typeof window).not.toBe('undefined');
  });

  it('A1 a push to another path is a path navigation from the committed location', () => {
    noteCommittedLocation('/dashboard/inventory?x=1');
    window.history.replaceState(null, '', '/dashboard/inventory?x=1');
    recordRouterTransitionStart('/dashboard/orders', 'push');
    expect(nav()).toMatchObject({
      kind: 'path',
      type: 'push',
      fromKey: '/dashboard/inventory?x=1',
      targetPath: '/dashboard/orders',
    });
  });

  it('A1b push and replace leave the COMMITTED location, not window.location (a shallow pushState moves it first)', () => {
    noteCommittedLocation('/a');
    window.history.replaceState(null, '', '/a?x=1');
    recordRouterTransitionStart('/b', 'push');
    expect(nav().fromKey).toBe('/a');
    recordRouterTransitionStart('/c', 'replace');
    expect(nav().fromKey).toBe('/a');
  });

  it('outside the shell (nothing committed) push falls back to window.location', () => {
    window.history.replaceState(null, '', '/login?next=%2Fdashboard');
    recordRouterTransitionStart('/dashboard', 'replace');
    expect(nav()).toMatchObject({ kind: 'path', fromKey: '/login?next=%2Fdashboard' });
  });

  it('A2 a query-only push is a query navigation; a relative ?page=2 resolves against the location', () => {
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('?page=2', 'push');
    expect(nav()).toMatchObject({ kind: 'query', targetPath: '/dashboard/inventory' });
  });

  it('A3 the same URL, a hash-only push and the same params spelled differently are "same"', () => {
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('/dashboard/inventory', 'push');
    expect(nav().kind).toBe('same');
    recordRouterTransitionStart('#photos', 'push');
    expect(nav().kind).toBe('same');

    window.history.replaceState(null, '', '/dashboard/inventory?q=a+b');
    noteCommittedLocation('/dashboard/inventory?q=a+b');
    recordRouterTransitionStart('/dashboard/inventory?q=a%20b', 'push');
    expect(nav().kind).toBe('same');
  });

  it('A4 Back/Forward leaves the committed location: window.location has already moved', () => {
    noteCommittedLocation('/a');
    window.history.replaceState(null, '', '/b');
    recordRouterTransitionStart(`${ORIGIN}/b`, 'traverse');
    expect(nav()).toMatchObject({ kind: 'path', type: 'traverse', fromKey: '/a', targetPath: '/b' });
  });

  it('A5 Back/Forward with no committed location (outside the shell) is "same"', () => {
    noteCommittedLocation('/a');
    noteCommittedLocation(null);
    window.history.replaceState(null, '', '/b');
    recordRouterTransitionStart(`${ORIGIN}/b`, 'traverse');
    expect(nav()).toMatchObject({ kind: 'same', fromKey: '' });
  });

  it('A6 another origin is "same": it never starts a skeleton', () => {
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('https://evil.example/x', 'push');
    expect(nav().kind).toBe('same');
  });

  it('A7 ids increase and listeners hear every start until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRouterNavigation(listener);
    recordRouterTransitionStart('/dashboard/orders', 'push');
    const first = nav();
    recordRouterTransitionStart('/dashboard/books', 'push');
    const second = nav();
    expect(second.id).toBeGreaterThan(first.id);
    expect(second).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    recordRouterTransitionStart('/dashboard', 'push');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('A9 a page restored from the back-forward cache has nothing in flight, and listeners hear it', () => {
    recordRouterTransitionStart('/dashboard/orders', 'push');
    const listener = vi.fn();
    const unsubscribe = subscribeRouterNavigation(listener);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(getRouterNavigation()).not.toBeNull();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(getRouterNavigation()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('A10 a navigation is retired once the committed location leaves where it started, and stays dead on return', () => {
    // Inventory's instant-mode view chips: pushState to K1 (no router start,
    // Next discards the row click's navigation), then pushState back to K0.
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('/dashboard/inventory/abc', 'push');
    const listener = vi.fn();
    const unsubscribe = subscribeRouterNavigation(listener);

    noteCommittedLocation('/dashboard/inventory?view=expected');
    expect(getRouterNavigation()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    noteCommittedLocation('/dashboard/inventory');
    expect(getRouterNavigation()).toBeNull();
    expect(pendingPathNavigationRemaining(getRouterNavigation(), '/dashboard/inventory', Date.now())).toBe(0);
    unsubscribe();
  });

  it('A11 a path replace as the page it leaves commits is a redirect; later, a push, a query or outside the shell is not', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/dashboard/inventory/new');
    noteCommittedLocation('/dashboard/inventory/new');
    recordRouterTransitionStart('/dashboard/inventory', 'replace');
    expect(nav()).toMatchObject({ kind: 'path', type: 'replace', redirect: true });
    recordRouterTransitionStart('/dashboard/inventory', 'push');
    expect(nav().redirect).toBe(false);
    recordRouterTransitionStart('?tab=photos', 'replace');
    expect(nav()).toMatchObject({ kind: 'query', redirect: false });

    vi.advanceTimersByTime(REDIRECT_FOLLOW_MS);
    recordRouterTransitionStart('/dashboard/inventory', 'replace');
    expect(nav().redirect).toBe(true);
    vi.advanceTimersByTime(1);
    recordRouterTransitionStart('/dashboard/inventory', 'replace');
    expect(nav().redirect).toBe(false);
    // Noting the same location again is not a new commit: the clock stays.
    noteCommittedLocation('/dashboard/inventory/new');
    recordRouterTransitionStart('/dashboard/inventory', 'replace');
    expect(nav().redirect).toBe(false);

    noteCommittedLocation(null);
    recordRouterTransitionStart('/dashboard/inventory', 'replace');
    expect(nav().redirect).toBe(false);
  });

  it('noting the committed location it started from (or null) does not retire it', () => {
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('/dashboard/orders', 'push');
    noteCommittedLocation('/dashboard/inventory');
    noteCommittedLocation(null);
    expect(getRouterNavigation()?.kind).toBe('path');
  });
});

describe('pendingPathNavigationRemaining (A8)', () => {
  it('counts down from 30 s for a path navigation from this key whose late skeleton is up, and is 0 otherwise', () => {
    vi.useFakeTimers();
    noteCommittedLocation('/dashboard/inventory');
    recordRouterTransitionStart('/dashboard/orders', 'push');
    const path = nav();
    const t0 = path.startedAt;

    // No skeleton covering the page: the bar keeps its 8 s failsafe.
    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 8_000)).toBe(0);
    noteLateSkeleton(path.id + 1);
    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 8_000)).toBe(0);
    noteLateSkeleton(path.id);

    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 8_000)).toBe(
      MAX_PENDING_NAVIGATION_MS - 8_000,
    );
    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 29_999)).toBe(1);
    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 30_000)).toBe(0);
    expect(pendingPathNavigationRemaining(path, '/dashboard/inventory', t0 + 45_000)).toBe(0);
    expect(pendingPathNavigationRemaining(path, '/dashboard/books', t0 + 1_000)).toBe(0);
    expect(pendingPathNavigationRemaining(null, '/dashboard/inventory', t0)).toBe(0);

    recordRouterTransitionStart('?page=2', 'push');
    expect(pendingPathNavigationRemaining(nav(), '/dashboard/inventory', t0 + 1_000)).toBe(0);
  });
});
