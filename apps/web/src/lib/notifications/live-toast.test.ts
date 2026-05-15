// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toastFn } = vi.hoisted(() => {
  return { toastFn: vi.fn() };
});

vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  flushLiveNotificationsForTest,
  isDesktopNotificationsEnabled,
  queueLiveNotification,
  setDesktopOptIn,
} from './live-toast';

const navigate = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  toastFn.mockClear();
  navigate.mockClear();
  window.localStorage.clear();
  flushLiveNotificationsForTest();
  // happy-dom defaults visibilityState to 'visible' — assert that
  // explicitly so a future env change can't silently flip these
  // tests into the wrong code path.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queueLiveNotification — single event', () => {
  it('fires one sonner toast after the burst window when only one event arrives', () => {
    queueLiveNotification(
      { id: 'a', type: 'order_request.created', title: 'New request', body: 'X', link: '/dashboard/orders/a' },
      navigate,
    );
    expect(toastFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1600);
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [title, opts] = toastFn.mock.calls[0]!;
    expect(title).toBe('New request');
    expect(opts.description).toBe('X');
    expect(opts.action.label).toBe('View');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/dashboard/orders/a');
  });

  it('drops the action when the link is missing', () => {
    queueLiveNotification(
      { id: 'b', type: 't', title: 'Hi', body: null, link: null },
      navigate,
    );
    vi.advanceTimersByTime(1600);
    const [, opts] = toastFn.mock.calls[0]!;
    expect(opts.action).toBeUndefined();
  });

  it('drops absolute and protocol-relative URLs (no action)', () => {
    queueLiveNotification(
      { id: 'c', type: 't', title: 'A', body: null, link: '//evil.com/x' },
      navigate,
    );
    queueLiveNotification(
      { id: 'c2', type: 't', title: 'B', body: null, link: 'https://evil.com/x' },
      navigate,
    );
    vi.advanceTimersByTime(1600);
    // Two events in window → summary, with no shared link (both bad)
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [, opts] = toastFn.mock.calls[0]!;
    // Action falls back to /dashboard/notifications
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/dashboard/notifications');
  });
});

describe('queueLiveNotification — burst collapse', () => {
  it('collapses 2+ events into a single summary toast', () => {
    for (let i = 0; i < 5; i++) {
      queueLiveNotification(
        {
          id: `id-${i}`,
          type: 'low_stock',
          title: `Item ${i} low`,
          body: null,
          link: `/dashboard/inventory/${i}`,
        },
        navigate,
      );
    }
    vi.advanceTimersByTime(1600);
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [title] = toastFn.mock.calls[0]!;
    expect(title).toBe('5 new notifications');
  });

  it('keeps the shared link when every event has the same target', () => {
    queueLiveNotification(
      { id: '1', type: 't', title: 'A', body: null, link: '/dashboard/orders/abc' },
      navigate,
    );
    queueLiveNotification(
      { id: '2', type: 't', title: 'B', body: null, link: '/dashboard/orders/abc' },
      navigate,
    );
    vi.advanceTimersByTime(1600);
    const [, opts] = toastFn.mock.calls[0]!;
    expect(opts.action.label).toBe('View');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/dashboard/orders/abc');
  });

  it('falls back to /dashboard/notifications when links differ', () => {
    queueLiveNotification(
      { id: '1', type: 't', title: 'A', body: null, link: '/dashboard/orders/x' },
      navigate,
    );
    queueLiveNotification(
      { id: '2', type: 't', title: 'B', body: null, link: '/dashboard/orders/y' },
      navigate,
    );
    vi.advanceTimersByTime(1600);
    const [, opts] = toastFn.mock.calls[0]!;
    expect(opts.action.label).toBe('View all');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/dashboard/notifications');
  });

  it('does NOT fire any toast when tab is hidden and desktop opt-in is off', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    queueLiveNotification(
      { id: 'h1', type: 't', title: 'A', body: null, link: '/x' },
      navigate,
    );
    vi.advanceTimersByTime(1600);
    expect(toastFn).not.toHaveBeenCalled();
  });
});

describe('isDesktopNotificationsEnabled', () => {
  it('returns false when the opt-in flag is not set', () => {
    // happy-dom does not implement Notification by default; stub it
    // with a permission='granted' to isolate the localStorage branch.
    (globalThis as Record<string, unknown>).Notification = { permission: 'granted' };
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it('returns true only when BOTH the flag and the granted permission are present', () => {
    (globalThis as Record<string, unknown>).Notification = { permission: 'granted' };
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(true);
  });

  it('returns false when the flag is set but the browser permission is denied', () => {
    (globalThis as Record<string, unknown>).Notification = { permission: 'denied' };
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it('returns false when Notification API is unavailable', () => {
    delete (globalThis as Record<string, unknown>).Notification;
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });
});

describe('setDesktopOptIn', () => {
  it('round-trips through localStorage', () => {
    setDesktopOptIn(true);
    expect(window.localStorage.getItem('stockpilot:desktop-notifications-opt-in')).toBe(
      '1',
    );
    setDesktopOptIn(false);
    expect(window.localStorage.getItem('stockpilot:desktop-notifications-opt-in')).toBeNull();
  });
});
