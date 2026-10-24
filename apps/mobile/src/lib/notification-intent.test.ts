import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  INTENT_TTL_MS,
  createNotificationIntentStore,
  type NotificationIntentDeps,
  type SessionLike,
  type TapResponse,
} from './notification-intent';
import type { RememberedIdentity } from './remembered-identity';

// The real singleton at the bottom of notification-intent.ts reaches for
// native modules at import; every test here builds its own store from fakes.
vi.mock('expo-notifications', () => ({}));
vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./remembered-identity', () => ({
  getRememberedIdentity: vi.fn(async () => null),
  normalizeIdentityEmail: (raw: string) => raw.trim().toLowerCase(),
}));
vi.mock('./push-open-diagnostics', () => ({
  pushOpenDiag: vi.fn(),
  errorClassOf: (err: unknown) => (err instanceof Error ? err.name : 'Error'),
}));

/**
 * The pending-intent coordinator (Phase 3, iPhone push tap). ONE place
 * captures a tapped notification, from the first moment of the JS runtime,
 * whoever is signed in: the launch tap (getLastNotificationResponse) and every
 * later tap (the one response listener). The host opens it once the app can.
 */

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const ORDER = '11111111-1111-4111-8111-111111111111';

function response(
  over: {
    id?: string;
    date?: number;
    link?: unknown;
    action?: string;
    title?: string | null;
    body?: string | null;
    data?: Record<string, unknown>;
  } = {},
): TapResponse {
  return {
    actionIdentifier: over.action ?? DEFAULT,
    notification: {
      date: over.date ?? 1000,
      request: {
        identifier: over.id ?? 'req-1',
        content: {
          title: over.title === undefined ? 'New order request' : over.title,
          body: over.body === undefined ? 'A request is waiting for approval.' : over.body,
          data: over.data ?? {
            link: over.link === undefined ? `/dashboard/orders/${ORDER}` : over.link,
          },
        },
      },
    },
  };
}

function harness(opts: { remembered?: () => Promise<RememberedIdentity | null> } = {}) {
  const calls: string[] = [];
  const listeners: ((r: TapResponse) => void)[] = [];
  let last: TapResponse | null = null;
  const notifications = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT,
    addNotificationResponseReceivedListener: vi.fn((fn: (r: TapResponse) => void) => {
      calls.push('subscribe');
      listeners.push(fn);
      return { remove: vi.fn() };
    }),
    // A receipt must never open anything: the store may not even listen.
    addNotificationReceivedListener: vi.fn(),
    getLastNotificationResponse: vi.fn((): TapResponse | null => {
      calls.push('read');
      return last;
    }),
    clearLastNotificationResponse: vi.fn(() => {
      last = null;
    }),
    dismissAllNotificationsAsync: vi.fn(async () => {}),
  };
  let authListener: ((session: SessionLike | null) => void) | null = null;
  let clock = 5_000_000;
  const diag = vi.fn();
  const readRememberedIdentity = vi.fn(opts.remembered ?? (async () => null));
  const deps: NotificationIntentDeps = {
    notifications,
    onAuthChange: (fn) => {
      authListener = fn;
    },
    readRememberedIdentity,
    diag,
    now: () => clock,
  };
  const store = createNotificationIntentStore(deps);
  return {
    store,
    notifications,
    calls,
    diag,
    readRememberedIdentity,
    /** A tap while the app runs: native records it, then the listener hears it. */
    tap(r: TapResponse) {
      last = r;
      for (const fn of listeners) fn(r);
    },
    /** The tap that launched the app (native holds it; no listener heard it). */
    launchedFrom(r: TapResponse) {
      last = r;
    },
    listenerCount: () => listeners.length,
    hear: (r: TapResponse) => listeners[0]?.(r),
    signedIn(id: string, email: string | null = null) {
      authListener?.({ user: { id, email } });
    },
    signedOut() {
      authListener?.(null);
    },
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('capture: from the first moment, one intent per tap', () => {
  it('start() subscribes to taps BEFORE it reads the launch tap', () => {
    const h = harness();
    h.launchedFrom(response());
    h.store.start();
    expect(h.calls.slice(0, 2)).toEqual(['subscribe', 'read']);
    expect(h.store.peek()).toMatchObject({ source: 'startup', identifier: 'req-1' });
  });

  it('start() runs once per JS runtime', () => {
    const h = harness();
    h.store.start();
    h.store.start();
    expect(h.notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(h.notifications.getLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it('the launch tap and its listener echo are ONE intent, even after it was opened', () => {
    const h = harness();
    const r = response();
    h.launchedFrom(r);
    h.store.start();
    h.hear(r);
    const intent = h.store.peek();
    expect(intent).toMatchObject({ seq: 1, source: 'startup' });
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'ignore',
      source: 'listener',
      reason: 'duplicate',
    });
    h.store.finish(intent!, 'navigated');
    h.hear(r);
    expect(h.store.peek()).toBeNull();
  });

  it('two notifications for the same order are both handled, in turn', () => {
    const h = harness();
    h.store.start();
    h.signedIn('u1');
    h.tap(response({ id: 'req-a', date: 1 }));
    const first = h.store.peek()!;
    h.store.finish(first, 'navigated');
    h.tap(response({ id: 'req-b', date: 2 })); // same link, a later delivery
    expect(h.store.peek()).toMatchObject({ seq: 2, identifier: 'req-b' });
    h.store.finish(h.store.peek()!, 'already-there');
    h.tap(response({ id: 'req-b', date: 3 })); // same identifier, delivered again
    expect(h.store.peek()).toMatchObject({ seq: 3, deliveredAt: 3 });
  });

  it('only the default action (the tap itself) is taken', () => {
    const h = harness();
    h.store.start();
    h.tap(response({ action: 'snooze' }));
    expect(h.store.peek()).toBeNull();
    expect(h.store.seenThisLaunch()).toBe(false);
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'ignore',
      source: 'listener',
      reason: 'not-default-action',
    });
  });

  it('the newest tap wins', () => {
    const h = harness();
    h.store.start();
    h.tap(response({ id: 'a', date: 10 }));
    h.tap(response({ id: 'b', date: 5 })); // an older alert, tapped later
    expect(h.store.peek()).toMatchObject({ identifier: 'b', seq: 2 });
  });

  it('the launch tap never overwrites a newer tap', () => {
    const h = harness();
    const launch = response({ id: 'launch', date: 100 });
    const newer = response({ id: 'newer', date: 50 });
    // The listener hears a tap while the launch tap is being read.
    h.notifications.getLastNotificationResponse.mockImplementationOnce(() => {
      h.calls.push('read');
      h.hear(newer);
      return launch;
    });
    h.store.start();
    expect(h.store.peek()).toMatchObject({ identifier: 'newer', source: 'listener' });
    expect(h.diag).toHaveBeenCalledWith({ stage: 'ignore', source: 'startup', reason: 'older' });
  });

  it('a native function that is missing is caught, and the listener still works', () => {
    const h = harness();
    const missing = new Error(
      'The method or property ExpoNotifications.getLastNotificationResponse is not available',
    );
    missing.name = 'UnavailabilityError';
    h.notifications.getLastNotificationResponse.mockImplementationOnce(() => {
      throw missing;
    });
    expect(() => h.store.start()).not.toThrow();
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'error',
      reason: 'unavailable',
      errorClass: 'UnavailabilityError',
    });
    expect(h.listenerCount()).toBe(1);
    h.tap(response());
    expect(h.store.peek()).toMatchObject({ source: 'listener' });
  });

  it('start() never throws, even when nothing native can be reached', () => {
    const h = harness();
    h.notifications.addNotificationResponseReceivedListener.mockImplementationOnce(() => {
      throw new Error('no emitter');
    });
    expect(() => h.store.start()).not.toThrow();
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'error',
      reason: 'listener-unavailable',
      errorClass: 'Error',
    });
  });

  it('seenThisLaunch() turns true on an accepted tap, including one with no page', () => {
    const h = harness();
    h.store.start();
    expect(h.store.seenThisLaunch()).toBe(false);
    h.tap(response({ link: null, id: 'no-link' }));
    expect(h.store.seenThisLaunch()).toBe(true);
  });

  it('a receipt never opens anything: the store never listens for delivered notifications', () => {
    const h = harness();
    h.store.start();
    h.tap(response());
    expect(h.notifications.addNotificationReceivedListener).not.toHaveBeenCalled();
    const src = readFileSync(path.join(__dirname, 'notification-intent.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toContain('addNotificationReceivedListener');
  });

  it("keeps the push's title and body only for a link the app cannot open", () => {
    const h = harness();
    h.store.start();
    h.tap(response({ id: 'ok' }));
    expect(h.store.peek()).toMatchObject({ title: null, body: null, target: { ok: true } });
    h.tap(
      response({ id: 'none', link: null, title: 'Push test', body: 'Hello from the test route' }),
    );
    expect(h.store.peek()).toMatchObject({
      title: 'Push test',
      body: 'Hello from the test route',
      target: { ok: false, reason: 'no-link' },
    });
  });

  it('never keeps an organization from push data', () => {
    const h = harness();
    h.store.start();
    h.tap(
      response({
        data: {
          link: `/dashboard/orders/${ORDER}`,
          organization_id: 'org-from-push',
          orgId: 'org-from-push',
          org_id: 'org-from-push',
        },
      }),
    );
    expect(JSON.stringify(h.store.peek())).not.toContain('org-from-push');
  });

  it('a response of the wrong shape is ignored safely', () => {
    const h = harness();
    h.store.start();
    expect(() =>
      h.store.capture({ actionIdentifier: DEFAULT } as unknown as TapResponse, 'listener'),
    ).not.toThrow();
    expect(() => h.store.capture(null, 'listener')).not.toThrow();
  });

  it('subscribers hear every change of the pending tap', () => {
    const h = harness();
    const heard = vi.fn();
    const off = h.store.subscribe(heard);
    h.store.start();
    h.tap(response());
    expect(heard).toHaveBeenCalledTimes(1);
    h.store.finish(h.store.peek()!, 'navigated');
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    h.tap(response({ id: 'later' }));
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('clearing', () => {
  it("finish() clears native's last response only while it is still its own", () => {
    const h = harness();
    h.store.start();
    h.tap(response({ id: 'a' }));
    const a = h.store.peek()!;
    h.tap(response({ id: 'b' }));
    const b = h.store.peek()!;
    h.store.finish(a, 'navigated'); // an older tap: native holds b now
    expect(h.notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(h.store.peek()).toBe(b);
    h.store.finish(b, 'navigated');
    expect(h.notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    expect(h.store.peek()).toBeNull();
  });

  it('a deliberate sign-out and an eviction empty the slot; only the sign-out clears Notification Center', () => {
    const h = harness();
    h.store.start();
    h.tap(response({ id: 'a' }));
    h.store.clear('deliberate-sign-out');
    expect(h.store.peek()).toBeNull();
    expect(h.notifications.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    // Native's record of the tap goes too: a reload must not bring it back.
    expect(h.notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    h.tap(response({ id: 'b' }));
    h.store.clear('evicted');
    expect(h.store.peek()).toBeNull();
    expect(h.notifications.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(h.notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(2);
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'finish',
      source: 'listener',
      reason: 'deliberate-sign-out',
    });
    expect(h.diag).toHaveBeenCalledWith({ stage: 'finish', source: 'listener', reason: 'evicted' });
  });

  it('a failed Notification Center clear is caught', async () => {
    const h = harness();
    h.notifications.dismissAllNotificationsAsync.mockImplementationOnce(async () => {
      throw new Error('unavailable');
    });
    h.store.start();
    expect(() => h.store.clear('deliberate-sign-out')).not.toThrow();
    await flush();
    expect(h.diag).toHaveBeenCalledWith({
      stage: 'error',
      reason: 'dismiss-unavailable',
      errorClass: 'Error',
    });
  });
});

describe('take(): whose tap it is, and whether it is still wanted', () => {
  it(`waits at most ${INTENT_TTL_MS / 60_000} minutes`, () => {
    expect(INTENT_TTL_MS).toBe(15 * 60 * 1000);
    const h = harness();
    h.store.start();
    h.signedIn('u1');
    h.tap(response());
    h.advance(INTENT_TTL_MS);
    expect(h.store.take({ id: 'u1' }, h.now())).toMatchObject({ kind: 'ready' });
    h.advance(1);
    expect(h.store.take({ id: 'u1' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'expired',
    });
  });

  it('nothing pending: none', () => {
    const h = harness();
    h.store.start();
    expect(h.store.take({ id: 'u1' }, h.now())).toEqual({ kind: 'none' });
  });

  it('a tap while signed in belongs to that account; the id decides', () => {
    const h = harness();
    h.store.start();
    h.signedIn('u1', 'a@example.com');
    h.tap(response());
    expect(h.store.peek()?.binding).toEqual({ userId: 'u1', email: 'a@example.com' });
    expect(h.store.take({ id: 'u1', email: 'a@example.com' }, h.now())).toMatchObject({
      kind: 'ready',
    });
    expect(h.store.take({ id: 'u2', email: 'a@example.com' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'account-mismatch',
    });
  });

  it("a tap while signed out belongs to this device's remembered identity", async () => {
    const h = harness({ remembered: async () => ({ userId: 'u1', email: 'a@example.com' }) });
    h.store.start();
    h.signedOut();
    h.tap(response());
    expect(h.store.peek()?.binding).toBe('resolving');
    expect(h.store.take({ id: 'u1' }, h.now())).toMatchObject({
      kind: 'waiting',
      reason: 'binding',
    });
    await flush();
    expect(h.store.peek()?.binding).toEqual({ userId: 'u1', email: 'a@example.com' });
    expect(h.store.take({ id: 'u1' }, h.now())).toMatchObject({ kind: 'ready' });
    expect(h.store.take({ id: 'u2' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'account-mismatch',
    });
  });

  it('an identity remembered by email only is matched by the normalised email', async () => {
    const h = harness({ remembered: async () => ({ userId: null, email: 'a@example.com' }) });
    h.store.start();
    h.signedOut();
    h.tap(response());
    await flush();
    expect(h.store.take({ id: 'u9', email: '  A@Example.com ' }, h.now())).toMatchObject({
      kind: 'ready',
    });
    expect(h.store.take({ id: 'u9', email: 'b@example.com' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'account-mismatch',
    });
    expect(h.store.take({ id: 'u9' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'account-mismatch',
    });
  });

  it('no remembered identity, or an unreadable one: dropped, fail-closed', async () => {
    const none = harness({ remembered: async () => null });
    none.store.start();
    none.signedOut();
    none.tap(response());
    await flush();
    expect(none.store.peek()?.binding).toBe('none');
    expect(none.store.take({ id: 'u1' }, none.now())).toMatchObject({
      kind: 'dropped',
      reason: 'unbound',
    });

    const broken = harness({
      remembered: async () => Promise.reject(new Error('keychain locked')),
    });
    broken.store.start();
    broken.signedOut();
    broken.tap(response());
    await flush();
    expect(broken.store.take({ id: 'u1' }, broken.now())).toMatchObject({
      kind: 'dropped',
      reason: 'unbound',
    });
  });

  it('the launch tap waits for the first auth event, then binds the same way', async () => {
    const signedInLaunch = harness();
    signedInLaunch.launchedFrom(response());
    signedInLaunch.store.start();
    expect(signedInLaunch.store.peek()?.binding).toBe('awaiting-auth');
    expect(signedInLaunch.store.take({ id: 'u1' }, signedInLaunch.now())).toMatchObject({
      kind: 'waiting',
    });
    signedInLaunch.signedIn('u1');
    expect(signedInLaunch.store.take({ id: 'u1' }, signedInLaunch.now())).toMatchObject({
      kind: 'ready',
    });

    const signedOutLaunch = harness({ remembered: async () => ({ userId: 'u7', email: null }) });
    signedOutLaunch.launchedFrom(response());
    signedOutLaunch.store.start();
    signedOutLaunch.signedOut();
    await flush();
    expect(signedOutLaunch.store.take({ id: 'u7' }, signedOutLaunch.now())).toMatchObject({
      kind: 'ready',
    });
  });

  it('a later sign-in never rebinds a tap that is already bound', () => {
    const h = harness();
    h.store.start();
    h.signedIn('u1');
    h.tap(response());
    h.signedIn('u2');
    expect(h.store.take({ id: 'u2' }, h.now())).toMatchObject({
      kind: 'dropped',
      reason: 'account-mismatch',
    });
  });

  it('a late identity read for a tap that was replaced is ignored', async () => {
    let releaseFirst!: (identity: RememberedIdentity | null) => void;
    const reads = [
      new Promise<RememberedIdentity | null>((resolve) => {
        releaseFirst = resolve;
      }),
      Promise.resolve<RememberedIdentity | null>({ userId: 'u1', email: null }),
    ];
    const h = harness({ remembered: () => reads.shift()! });
    h.store.start();
    h.signedOut();
    h.tap(response({ id: 'a' }));
    h.tap(response({ id: 'b' }));
    await flush();
    releaseFirst({ userId: 'someone-else', email: null });
    await flush();
    expect(h.store.peek()).toMatchObject({
      identifier: 'b',
      binding: { userId: 'u1', email: null },
    });
  });

  it('no session yet: waiting', () => {
    const h = harness();
    h.store.start();
    h.signedIn('u1');
    h.tap(response());
    expect(h.store.take(null, h.now())).toMatchObject({ kind: 'waiting', reason: 'signed-out' });
  });
});
