/**
 * THE ONE PENDING-INTENT COORDINATOR FOR A TAPPED NOTIFICATION (Phase 3,
 * iPhone push tap).
 *
 * THE BUG. A tap on "New order" in the iPhone's Notification Center opened
 * Home, not the order. The only response listener was installed inside the
 * token-registration effect, which runs after the fonts load, the session is
 * restored and a user exists. A tap that LAUNCHED the app was emitted before
 * any listener existed, and nothing read the response Expo keeps for exactly
 * that case (getLastNotificationResponse). A signed-out tap, the sign-in
 * redirect, the MFA and Face ID screens (which unmount the navigator) and the
 * launch OTA reload each lost it too.
 *
 * THE COORDINATOR. start() runs once per JS runtime, at module scope in
 * app/_layout.tsx, before any gate. It subscribes the ONE response listener
 * FIRST and then reads the launch tap once, so a tap is never missed between
 * the two, and the overlap (the same tap from both) is one intent: the dedupe
 * key is the request identifier plus the delivery date. A later notification
 * for the same order has a new key and opens again. Only the default action
 * (the tap itself) is taken, and a receipt never opens anything: this module
 * never listens for delivered notifications.
 *
 * Capture does not navigate. It keeps ONE pending intent (the newest tap wins;
 * the launch tap never overwrites a tap the listener has already delivered)
 * until NotificationIntentHost, mounted with the navigator after every gate,
 * opens it and calls finish().
 *
 * WHOSE TAP. A shared warehouse phone changes hands, so a captured tap is
 * bound to an account: the one signed in, or, signed out, this device's
 * remembered identity (remembered-identity.ts). A launch tap waits for the
 * first auth event and binds the same way. take() hands it only to that
 * account; anyone else gets a neutral line, and no identity at all fails
 * closed. The RLS-scoped reads behind every screen remain the authorisation.
 * A deliberate sign-out and an eviction drop it, and a deliberate sign-out
 * clears this app's alerts from Notification Center too, so the next person
 * cannot tap the previous user's.
 *
 * Nothing here trusts push data beyond the link: no organization, no user.
 */
import * as Notifications from 'expo-notifications';
import * as React from 'react';

import { parseNotificationLink, type NotificationTarget } from './notification-link';
import {
  errorClassOf,
  pushOpenDiag,
  type PushOpenEvent,
  type PushOpenReason,
} from './push-open-diagnostics';
import {
  getRememberedIdentity,
  normalizeIdentityEmail,
  type RememberedIdentity,
} from './remembered-identity';
import { supabase } from './supabase';

/** How long a tapped destination waits for sign-in (owner decision 4). */
export const INTENT_TTL_MS = 15 * 60 * 1000;

/** How many taps are remembered as handled, for the dedupe. */
export const SEEN_KEYS_LIMIT = 50;

/** The part of an expo-notifications response the coordinator reads. */
export interface TapResponse {
  actionIdentifier: string;
  notification: {
    date: number;
    request: {
      identifier: string;
      content: { title?: string | null; body?: string | null; data?: unknown };
    };
  };
}

/** The expo-notifications calls the coordinator makes (injected for tests). */
export interface TapNotifications {
  addNotificationResponseReceivedListener(listener: (response: TapResponse) => void): {
    remove(): void;
  };
  getLastNotificationResponse(): TapResponse | null;
  clearLastNotificationResponse(): void;
  dismissAllNotificationsAsync(): Promise<void>;
  DEFAULT_ACTION_IDENTIFIER: string;
}

export interface SessionLike {
  user: { id: string; email?: string | null };
}

export interface NotificationIntentDeps {
  notifications: TapNotifications;
  /** supabase.auth.onAuthStateChange; the first call is the restored session. */
  onAuthChange(listener: (session: SessionLike | null) => void): void;
  readRememberedIdentity(): Promise<RememberedIdentity | null>;
  diag(event: PushOpenEvent): void;
  now(): number;
}

export type IntentSource = 'startup' | 'listener';

export interface IntentAccount {
  userId: string | null;
  /** Normalised (remembered-identity.ts normalizeIdentityEmail). */
  email: string | null;
}

/** Whose tap this is: an account, or not known yet, or nobody (fail closed). */
export type IntentBinding = IntentAccount | 'awaiting-auth' | 'resolving' | 'none';

export interface CapturedIntent {
  readonly key: string;
  readonly identifier: string;
  readonly seq: number;
  readonly source: IntentSource;
  /** This phone's clock when the tap was captured (the TTL runs from here). */
  readonly capturedAt: number;
  /** notification.date, as native reports it. */
  readonly deliveredAt: number;
  readonly target: NotificationTarget;
  /** The push's own words, kept ONLY when the target cannot be opened (the
   *  fallback notice shows them). Never logged. */
  readonly title: string | null;
  readonly body: string | null;
  readonly binding: IntentBinding;
}

export interface IntentUser {
  id: string;
  email?: string | null;
}

export type TakeResult =
  | { kind: 'none' }
  | { kind: 'waiting'; reason: 'binding' | 'signed-out'; intent: CapturedIntent }
  | { kind: 'ready'; intent: CapturedIntent }
  | { kind: 'dropped'; reason: 'account-mismatch' | 'expired' | 'unbound'; intent: CapturedIntent };

export type ClearReason = 'deliberate-sign-out' | 'evicted';

export interface NotificationIntentStore {
  /** Subscribe the listener, then read the launch tap. Once per runtime. */
  start(): void;
  capture(response: TapResponse | null | undefined, source: IntentSource): void;
  /** The pending tap, or null. A new object whenever it changes. */
  peek(): CapturedIntent | null;
  subscribe(listener: () => void): () => void;
  /** Whether the pending tap may be opened for this user now. Reads only. */
  take(user: IntentUser | null, now: number): TakeResult;
  /** The tap is handled: empty the slot (if it is still this one). */
  finish(intent: CapturedIntent, outcome: PushOpenReason): void;
  clear(reason: ClearReason): void;
  /** True once this launch has taken a tap (the OTA reload waits). */
  seenThisLaunch(): boolean;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function accountOf(session: SessionLike | null): IntentAccount | null {
  const user = session?.user;
  if (!user?.id) return null;
  return { userId: user.id, email: user.email ? normalizeIdentityEmail(user.email) : null };
}

function rememberedAccount(identity: RememberedIdentity | null): IntentAccount | null {
  if (!identity || (!identity.userId && !identity.email)) return null;
  return {
    userId: identity.userId ?? null,
    email: identity.email ? normalizeIdentityEmail(identity.email) : null,
  };
}

function sameAccount(account: IntentAccount, user: IntentUser): boolean {
  if (account.userId) return account.userId === user.id;
  if (account.email) return !!user.email && normalizeIdentityEmail(user.email) === account.email;
  return false;
}

export function createNotificationIntentStore(
  deps: NotificationIntentDeps,
): NotificationIntentStore {
  let started = false;
  let seq = 0;
  let seen = false;
  let pending: CapturedIntent | null = null;
  let auth: { known: boolean; account: IntentAccount | null } = { known: false, account: null };
  /** Keys of taps already taken, oldest first. */
  const seenKeys: string[] = [];
  const listeners = new Set<() => void>();

  const setPending = (next: CapturedIntent | null) => {
    pending = next;
    for (const fn of listeners) fn();
  };

  /** False when the key was already taken (it is then the most recent). */
  const firstSighting = (key: string): boolean => {
    const at = seenKeys.indexOf(key);
    if (at >= 0) {
      seenKeys.splice(at, 1);
      seenKeys.push(key);
      return false;
    }
    seenKeys.push(key);
    if (seenKeys.length > SEEN_KEYS_LIMIT) seenKeys.shift();
    return true;
  };

  /** A live tap is the newest tap there is. The launch tap, read once at
   *  start, is older than any tap the listener has already delivered. */
  const replaces = (current: CapturedIntent, source: IntentSource, deliveredAt: number) =>
    source === 'listener' || (current.source === 'startup' && deliveredAt > current.deliveredAt);

  /** Bind a signed-out tap to the device's remembered identity. */
  const bindToRemembered = (forSeq: number) => {
    const settle = (identity: RememberedIdentity | null) => {
      // Another tap took the slot meanwhile: this answer is not for it.
      if (!pending || pending.seq !== forSeq || pending.binding !== 'resolving') return;
      setPending({ ...pending, binding: rememberedAccount(identity) ?? 'none' });
    };
    try {
      deps.readRememberedIdentity().then(settle, () => settle(null));
    } catch {
      settle(null);
    }
  };

  const capture: NotificationIntentStore['capture'] = (response, source) => {
    if (!response) return;
    if (response.actionIdentifier !== deps.notifications.DEFAULT_ACTION_IDENTIFIER) {
      deps.diag({ stage: 'ignore', source, reason: 'not-default-action' });
      return;
    }
    const notification = response.notification;
    const request = notification?.request;
    if (!request) {
      deps.diag({ stage: 'ignore', source, reason: 'malformed' });
      return;
    }
    const identifier = typeof request.identifier === 'string' ? request.identifier : '';
    const deliveredAt = typeof notification?.date === 'number' ? notification.date : 0;
    const key = `${identifier}|${deliveredAt}`;
    if (!firstSighting(key)) {
      deps.diag({ stage: 'ignore', source, reason: 'duplicate' });
      return;
    }
    if (pending && !replaces(pending, source, deliveredAt)) {
      deps.diag({ stage: 'ignore', source, reason: 'older' });
      return;
    }
    const content = request.content;
    const data = content?.data;
    const target = parseNotificationLink(
      typeof data === 'object' && data !== null ? (data as { link?: unknown }).link : undefined,
    );
    seq += 1;
    const binding: IntentBinding = !auth.known ? 'awaiting-auth' : (auth.account ?? 'resolving');
    const intent: CapturedIntent = {
      key,
      identifier,
      seq,
      source,
      capturedAt: deps.now(),
      deliveredAt,
      target,
      title: target.ok ? null : textOf(content?.title),
      body: target.ok ? null : textOf(content?.body),
      binding,
    };
    seen = true;
    setPending(intent);
    deps.diag({
      stage: 'capture',
      source,
      linkKind: target.linkKind,
      ...(target.ok ? { routeKind: target.routeKind } : { reason: target.reason }),
    });
    if (binding === 'resolving') bindToRemembered(intent.seq);
  };

  const onAuth = (session: SessionLike | null) => {
    const account = accountOf(session);
    auth = { known: true, account };
    // A tap taken before auth was known binds at the first event, once.
    if (pending?.binding !== 'awaiting-auth') return;
    setPending({ ...pending, binding: account ?? 'resolving' });
    if (!account) bindToRemembered(pending.seq);
  };

  /** Native's record of a tap, cleared when it is this one (or any, when
   *  `only` is omitted). A missing native function is reported, never thrown. */
  const clearNative = (only?: CapturedIntent) => {
    try {
      const last = deps.notifications.getLastNotificationResponse();
      if (!last) return;
      if (only && last.notification?.request?.identifier !== only.identifier) return;
      deps.notifications.clearLastNotificationResponse();
    } catch (err) {
      deps.diag({ stage: 'error', reason: 'clear-unavailable', errorClass: errorClassOf(err) });
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      // FIRST the listener, THEN the launch tap: a tap delivered in between is
      // heard, and the two sightings of one tap share a key.
      try {
        deps.notifications.addNotificationResponseReceivedListener((response) =>
          capture(response, 'listener'),
        );
      } catch (err) {
        deps.diag({
          stage: 'error',
          reason: 'listener-unavailable',
          errorClass: errorClassOf(err),
        });
      }
      let launch: TapResponse | null = null;
      try {
        launch = deps.notifications.getLastNotificationResponse();
      } catch (err) {
        deps.diag({ stage: 'error', reason: 'unavailable', errorClass: errorClassOf(err) });
      }
      capture(launch, 'startup');
      try {
        deps.onAuthChange(onAuth);
      } catch (err) {
        deps.diag({ stage: 'error', reason: 'unavailable', errorClass: errorClassOf(err) });
      }
    },

    capture,

    peek: () => pending,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    take(user, now) {
      const intent = pending;
      if (!intent) return { kind: 'none' };
      if (now - intent.capturedAt > INTENT_TTL_MS) {
        return { kind: 'dropped', reason: 'expired', intent };
      }
      const binding = intent.binding;
      if (binding === 'awaiting-auth' || binding === 'resolving') {
        return { kind: 'waiting', reason: 'binding', intent };
      }
      if (binding === 'none') return { kind: 'dropped', reason: 'unbound', intent };
      if (!user) return { kind: 'waiting', reason: 'signed-out', intent };
      return sameAccount(binding, user)
        ? { kind: 'ready', intent }
        : { kind: 'dropped', reason: 'account-mismatch', intent };
    },

    finish(intent, outcome) {
      if (pending?.seq === intent.seq) setPending(null);
      deps.diag({ stage: 'finish', source: intent.source, reason: outcome });
      // Only while native still holds THIS tap: finishing an older tap must
      // never wipe a newer one.
      clearNative(intent);
    },

    clear(reason) {
      const had = pending;
      if (had) {
        setPending(null);
        deps.diag({ stage: 'finish', source: had.source, reason });
      }
      clearNative();
      if (reason !== 'deliberate-sign-out') return;
      // The alerts still in Notification Center belong to the account that is
      // leaving: the next person on this phone must not be able to tap them.
      const reportDismiss = (err: unknown) =>
        deps.diag({ stage: 'error', reason: 'dismiss-unavailable', errorClass: errorClassOf(err) });
      try {
        void deps.notifications.dismissAllNotificationsAsync().catch(reportDismiss);
      } catch (err) {
        reportDismiss(err);
      }
    },

    seenThisLaunch: () => seen,
  };
}

type IntentGlobal = typeof globalThis & {
  __stockpilotNotificationIntents?: NotificationIntentStore;
};

function createAppStore(): NotificationIntentStore {
  return createNotificationIntentStore({
    notifications: Notifications,
    onAuthChange(listener) {
      supabase.auth.onAuthStateChange((_event, session) => listener(session));
    },
    readRememberedIdentity: getRememberedIdentity,
    diag: pushOpenDiag,
    now: () => Date.now(),
  });
}

/**
 * The app's coordinator. Kept on globalThis so a Fast Refresh that re-runs
 * this module keeps the one listener and the pending tap.
 */
export const notificationIntents: NotificationIntentStore =
  (globalThis as IntentGlobal).__stockpilotNotificationIntents ??
  ((globalThis as IntentGlobal).__stockpilotNotificationIntents = createAppStore());

/** The pending tap, re-rendering whenever it changes. */
export function usePendingNotificationIntent(): CapturedIntent | null {
  return React.useSyncExternalStore(notificationIntents.subscribe, notificationIntents.peek);
}
