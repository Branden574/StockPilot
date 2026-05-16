// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toastInfoFn } = vi.hoisted(() => {
  return { toastInfoFn: vi.fn() };
});

vi.mock('sonner', () => ({
  toast: {
    info: toastInfoFn,
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  flushLiveNotificationsForTest,
  isDesktopNotificationsEnabled,
  isNotificationSoundMuted,
  queueLiveNotification,
  setDesktopOptIn,
  setNotificationSoundMuted,
} from './live-toast';

const navigate = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  toastInfoFn.mockClear();
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
  it('fires the toast INSTANTLY (no burst delay)', async () => {
    queueLiveNotification(
      { id: 'a', type: 'order_request.created', title: 'New request', body: 'X', link: '/dashboard/orders/a' },
      navigate,
    );
    // Drain microtasks scheduled by fireOne so the toast call lands.
    await vi.advanceTimersByTimeAsync(0);
    expect(toastInfoFn).toHaveBeenCalledTimes(1);
    const [title, opts] = toastInfoFn.mock.calls[0]!;
    expect(title).toBe('New request');
    expect(opts.description).toBe('X');
    expect(opts.action.label).toBe('View');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/dashboard/orders/a');
  });

  it('drops the action when the link is missing', async () => {
    queueLiveNotification(
      { id: 'b', type: 't', title: 'Hi', body: null, link: null },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(0);
    const [, opts] = toastInfoFn.mock.calls[0]!;
    expect(opts.action).toBeUndefined();
  });

  it('drops absolute and protocol-relative URLs (no action)', async () => {
    queueLiveNotification(
      { id: 'c', type: 't', title: 'A', body: null, link: '//evil.com/x' },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(0);
    // First fire — link rejected, no action attached
    const firstCall = toastInfoFn.mock.calls[0]!;
    expect(firstCall[1].action).toBeUndefined();
  });
});

describe('queueLiveNotification — burst collapse', () => {
  it('fires the FIRST event instantly, then a summary for the rest at the end of the window', async () => {
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
    // First fire is synchronous — the toast for `Item 0 low` lands now.
    await vi.advanceTimersByTimeAsync(0);
    expect(toastInfoFn).toHaveBeenCalledTimes(1);
    expect(toastInfoFn.mock.calls[0]![0]).toBe('Item 0 low');

    // After the window closes, the remaining 4 collapse to a summary.
    await vi.advanceTimersByTimeAsync(1600);
    expect(toastInfoFn).toHaveBeenCalledTimes(2);
    expect(toastInfoFn.mock.calls[1]![0]).toBe('4 new notifications');
  });

  it('fires the second event as a normal toast (not a summary) when only one extra arrives in the window', async () => {
    queueLiveNotification(
      { id: '1', type: 't', title: 'First', body: null, link: '/dashboard/orders/abc' },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(0);
    queueLiveNotification(
      { id: '2', type: 't', title: 'Second', body: null, link: '/dashboard/orders/abc' },
      navigate,
    );
    // Still only one fire so far — the second is queued for the
    // post-window flush.
    expect(toastInfoFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(toastInfoFn).toHaveBeenCalledTimes(2);
    expect(toastInfoFn.mock.calls[1]![0]).toBe('Second');
  });

  it('does NOT fire any toast when tab is hidden and desktop opt-in is off', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    queueLiveNotification(
      { id: 'h1', type: 't', title: 'A', body: null, link: '/x' },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(1600);
    expect(toastInfoFn).not.toHaveBeenCalled();
  });
});

describe('isDesktopNotificationsEnabled', () => {
  it('returns false when the opt-in flag is not set', async () => {
    (globalThis as Record<string, unknown>).Notification = { permission: 'granted' };
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it('returns true only when BOTH the flag and the granted permission are present', async () => {
    (globalThis as Record<string, unknown>).Notification = { permission: 'granted' };
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(true);
  });

  it('returns false when the flag is set but the browser permission is denied', async () => {
    (globalThis as Record<string, unknown>).Notification = { permission: 'denied' };
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });

  it('returns false when Notification API is unavailable', async () => {
    delete (globalThis as Record<string, unknown>).Notification;
    setDesktopOptIn(true);
    expect(isDesktopNotificationsEnabled()).toBe(false);
  });
});

describe('setDesktopOptIn', () => {
  it('round-trips through localStorage', async () => {
    setDesktopOptIn(true);
    expect(window.localStorage.getItem('stockpilot:desktop-notifications-opt-in')).toBe(
      '1',
    );
    setDesktopOptIn(false);
    expect(window.localStorage.getItem('stockpilot:desktop-notifications-opt-in')).toBeNull();
  });
});

describe('notification sound preference', () => {
  it('defaults to NOT muted', () => {
    expect(isNotificationSoundMuted()).toBe(false);
  });

  it('round-trips through localStorage', () => {
    setNotificationSoundMuted(true);
    expect(window.localStorage.getItem('stockpilot:notification-sound-muted')).toBe('1');
    expect(isNotificationSoundMuted()).toBe(true);
    setNotificationSoundMuted(false);
    expect(window.localStorage.getItem('stockpilot:notification-sound-muted')).toBeNull();
    expect(isNotificationSoundMuted()).toBe(false);
  });
});

describe('cross-tab leader election (Web Locks)', () => {
  type LocksFn = (
    name: string,
    options: { ifAvailable: true; mode?: 'exclusive' },
    cb: (lock: unknown | null) => Promise<void> | void,
  ) => Promise<unknown>;

  function installLockManager(behavior: 'won' | 'denied'): {
    requests: Array<{ name: string }>;
  } {
    const requests: Array<{ name: string }> = [];
    const request: LocksFn = (name, _opts, cb) => {
      requests.push({ name });
      return Promise.resolve(
        cb(behavior === 'won' ? { name } : null),
      );
    };
    const g = globalThis as unknown as { navigator?: Record<string, unknown> };
    const existing = g.navigator ?? {};
    (globalThis as Record<string, unknown>).navigator = {
      ...existing,
      locks: { request },
    };
    return { requests };
  }

  function clearLockManager() {
    delete (globalThis as Record<string, unknown>).navigator;
  }

  afterEach(() => clearLockManager());

  it('fires the toast when this tab WINS the per-notification lock', async () => {
    const { requests } = installLockManager('won');
    queueLiveNotification(
      { id: 'win-1', type: 't', title: 'Hello', body: null, link: '/dashboard' },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(toastInfoFn).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([{ name: 'stockpilot-toast-win-1' }]);
  });

  it('SUPPRESSES the toast when another tab already holds the lock', async () => {
    installLockManager('denied');
    queueLiveNotification(
      { id: 'lose-1', type: 't', title: 'Hello', body: null, link: '/dashboard' },
      navigate,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(toastInfoFn).not.toHaveBeenCalled();
  });
});
