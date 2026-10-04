/**
 * Signing out without losing, or wrongly keeping, anything (S4b).
 *
 * THE DEFECT. signOut awaited `supabase.auth.signOut({ scope: 'global' })`,
 * ignored its result, and always ran wipeForSignOut(), which deleted every
 * pending, failed and sending outbox row: queued counts and bundle
 * distributions vanished with no drain attempt and no warning. Offline it was
 * worse: auth-js 2.105.1 returns `{ error }` on a transport failure WITHOUT
 * removing the session, so the user stayed signed in, on an empty cache, with
 * their work gone.
 *
 * A LOCAL sign-out needs the network too. `signOut({ scope: 'local' })` also
 * POSTs /logout and, on a transport failure, returns `{ error }` and keeps the
 * session (reproduced against the exact auth-js dist the app resolves). So
 * "fall back to local" rescues a global-only failure, never an offline one:
 * whether the session actually ended is read back from the session itself, and
 * nothing is wiped, and no gate is lifted, while one still exists.
 *
 * THE SEQUENCE (owner decision D5):
 *   1. count this account's unsynced rows (pending, failed, sending);
 *   2. if any and online, try to send them now (both drains), bounded, then
 *      recount;
 *   3. if any remain, ask: Stay signed in / Sign out (the rows stay on the
 *      device, held for this account, and send when it signs in here again) /
 *      Sign out and discard, offered ONLY after a real drain attempt;
 *   4. stamp this account's legacy rows as its own, so the next account never
 *      adopts them (outbox-scope.ts);
 *   5. sign out globally; on an error, locally; then read the session back;
 *   6. only once it is gone: discard (if chosen), clear the cache, and forget
 *      the account's saved workspace (the active organization and the
 *      per-organization warehouse, account-eviction.ts
 *      accountScopedStorageKeys). The outbox is never cleared by a sign-out.
 *
 * ORDER REQUESTS NOT CONFIRMED (phone ordering PO-4, plan 3.6). A sent order
 * request whose answer never arrived lives in the account's draft keys,
 * which step 6 removes, and only its key can still settle it. So, beside the
 * outbox: step 1 also counts them, step 2 reads each one's status (a read,
 * never a send), and if one is still unknown the prompt adds "1 order request
 * was sent but not confirmed" with "Don't send it and sign out" (withdraw
 * first; its answer is final and is reported) beside Stay and Sign out. Any
 * still unknown at sign-out get a hold marker with no personal data
 * (order-storefront/sign-out-hold.ts), read at this account's next sign-in.
 * Nothing about an order is ever resent here.
 *
 * Pure: every effect is injected, so the order can be executed in vitest (the
 * React Native auth context cannot load there).
 */

import {
  SIGN_OUT_COPY,
  SIGN_OUT_STAY_COPY,
  SIGN_OUT_UNCONFIRMED_HOLD_COPY,
  SIGN_OUT_UNCONFIRMED_TITLE_COPY,
  SIGN_OUT_WITHDRAW_COPY,
  signOutUnconfirmedOrdersCopy,
} from '@stockpilot/core';

export type UnsyncedChoice = 'stay' | 'sign-out' | 'discard' | 'withdraw-orders';

export type SignOutOutcome =
  /** The person chose to stay: nothing happened. */
  | 'stayed'
  /** Signed out; the cache was cleared. */
  | 'signed-out'
  /** Both sign-outs failed and a session still exists: nothing was removed. */
  | 'still-signed-in';

export type SignOutScope = 'global' | 'local';

export interface EndSessionDeps {
  signOut(scope: SignOutScope): Promise<{ error: unknown }>;
  hasSession(): Promise<boolean>;
  warn?: (message: string, err: unknown) => void;
}

/** This account's order requests that were sent but not confirmed (plan 3.6). */
export interface SignOutOrderSubmissions {
  /** How many, on this device, in every organization. */
  count(): Promise<number>;
  /** Read each one's status (never a send). Bounded by the flow. */
  settle(): Promise<void>;
  /** "Don't send it": withdraw each. The orders found already placed. */
  withdraw(): Promise<{ placed: string[] }>;
  /** Keep a marker (ids and counts only) for each still not settled. */
  hold(): Promise<void>;
  /** Say what the withdraw found: orders already placed, and how many could
   *  not be checked (those are held like Sign out). */
  report(result: { placed: string[]; unanswered: number }): Promise<void>;
}

export interface SignOutFlowDeps extends EndSessionDeps {
  /** This account's queued changes not yet on the server (pending/failed/sending). */
  countUnsynced(): Promise<number>;
  isOnline(): Promise<boolean>;
  /** Try to send them now (both drains). Bounded by the flow. */
  drain(): Promise<void>;
  confirmUnsynced(
    count: number,
    opts: { canDiscard: boolean; unconfirmedOrders?: number },
  ): Promise<UnsyncedChoice>;
  /** Order requests not confirmed (absent: none are counted). */
  orderSubmissions?: SignOutOrderSubmissions;
  /** Stamp this account's legacy rows (NULL owner) as its own. */
  holdForAccount(): Promise<void>;
  /** Delete this account's unsynced rows (only after the session is gone). */
  discardUnsynced(): Promise<void>;
  /** Clear the org-scoped cache. Never touches the outbox. */
  wipeCache(): Promise<void>;
  /**
   * Remove this account's saved workspace keys from AsyncStorage (the active
   * organization and the per-organization warehouse). They outlived an
   * ordinary sign-out: the next account's /api/v1 calls named the previous
   * account's organization (api.ts orgHeader) and its queued rows were
   * stamped with it (session-scope.ts) until its own workspace load
   * succeeded, and a failed first load never replaced it (review 2026-09-26).
   */
  clearAccountStorage(): Promise<void>;
}

/** How long the sign-out waits for the drains before asking anyway. */
export const SIGN_OUT_DRAIN_TIMEOUT_MS = 15_000;

/**
 * End the session and report whether it actually ended. `global` falls back
 * to `local` on an error. The answer is read back from the session, not
 * inferred from the calls: a transport failure keeps the session whatever the
 * scope. A throw is an error; an unreadable session counts as still present
 * (fail closed: nothing is wiped and no lock is lifted on a guess).
 *
 * `hasSession` must read the STORED session (session-scope.ts
 * hasStoredSession), never getSession(): with the access token expired and no
 * network, getSession() answers "no session" while auth-js keeps it on the
 * device, and the sign-out that failed looked like it had worked.
 */
export async function endSession(deps: EndSessionDeps, scope: SignOutScope): Promise<boolean> {
  const attempt = async (s: SignOutScope): Promise<boolean> => {
    try {
      const { error } = await deps.signOut(s);
      if (error) deps.warn?.(`[auth] ${s} sign-out failed`, error);
      return !error;
    } catch (e) {
      deps.warn?.(`[auth] ${s} sign-out threw`, e);
      return false;
    }
  };
  const ok = await attempt(scope);
  if (!ok && scope === 'global') await attempt('local');
  try {
    return !(await deps.hasSession());
  } catch (e) {
    deps.warn?.('[auth] could not read the session back after sign-out', e);
    return false;
  }
}

export async function runSignOutFlow(
  deps: SignOutFlowDeps,
  opts: {
    /** The account no longer exists (in-app deletion): its queued work can
     *  never be sent, so there is nothing to ask and it is discarded. */
    discardWithoutAsking?: boolean;
    drainTimeoutMs?: number;
  } = {},
): Promise<SignOutOutcome> {
  const warn = deps.warn ?? (() => undefined);
  const count = async () => {
    try {
      return await deps.countUnsynced();
    } catch (e) {
      // Unknowable, so do not ask. Nothing is lost by proceeding: a sign-out
      // no longer deletes queued work, it holds it for this account.
      warn('[auth] could not count unsynced changes', e);
      return 0;
    }
  };

  const orders = deps.orderSubmissions;
  const countOrders = async () => {
    if (!orders) return 0;
    try {
      return await orders.count();
    } catch (e) {
      warn('[auth] could not count unconfirmed order requests', e);
      return 0;
    }
  };

  let discard = opts.discardWithoutAsking === true;
  if (!discard) {
    let unsynced = await count();
    let unconfirmed = await countOrders();
    let drained = false;
    if ((unsynced > 0 || unconfirmed > 0) && (await deps.isOnline().catch(() => false))) {
      const work: Promise<void>[] = [];
      if (unsynced > 0) work.push(deps.drain());
      if (unconfirmed > 0 && orders) work.push(orders.settle());
      await withTimeout(
        Promise.all(work).then(() => undefined),
        opts.drainTimeoutMs ?? SIGN_OUT_DRAIN_TIMEOUT_MS,
      ).catch((e) => warn('[auth] pre-sign-out sync failed', e));
      if (unsynced > 0) {
        drained = true;
        unsynced = await count();
      }
      if (unconfirmed > 0) unconfirmed = await countOrders();
    }
    if (unsynced > 0 || unconfirmed > 0) {
      const choice = await deps.confirmUnsynced(unsynced, {
        canDiscard: drained && unsynced > 0,
        ...(unconfirmed > 0 ? { unconfirmedOrders: unconfirmed } : {}),
      });
      if (choice === 'stay') return 'stayed';
      // Discard exists only after a real attempt to send (D5).
      discard = choice === 'discard' && drained;
      if (choice === 'withdraw-orders' && orders) {
        let placed: string[] = [];
        try {
          placed = (await orders.withdraw()).placed;
        } catch (e) {
          warn('[auth] could not withdraw unconfirmed order requests', e);
        }
        const unanswered = await countOrders();
        try {
          await orders.report({ placed, unanswered });
        } catch (e) {
          warn('[auth] could not report the withdrawn order requests', e);
        }
      }
    }
  }

  // Whatever is still not confirmed is held for this account (a marker with
  // ids and counts only), read at its next sign-in. Before the session goes,
  // like the outbox's hold.
  if (orders && (await countOrders()) > 0) {
    try {
      await orders.hold();
    } catch (e) {
      warn('[auth] could not hold unconfirmed order requests', e);
    }
  }

  try {
    await deps.holdForAccount();
  } catch (e) {
    warn('[auth] could not hold queued changes for this account', e);
  }

  if (!(await endSession(deps, 'global'))) return 'still-signed-in';

  if (discard) {
    try {
      await deps.discardUnsynced();
    } catch (e) {
      warn('[auth] could not discard unsynced changes', e);
    }
  }
  try {
    await deps.wipeCache();
  } catch (e) {
    warn('[auth] wipe-on-signout failed', e);
  }
  // Only once the session is gone, like the wipe: a sign-out that failed
  // keeps the person in their workspace.
  try {
    await deps.clearAccountStorage();
  } catch (e) {
    warn('[auth] could not forget the saved workspace', e);
  }
  return 'signed-out';
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** One button of the unsynced-work prompt, in display order. */
export interface UnsyncedPromptButton {
  choice: UnsyncedChoice;
  label: string;
  style: 'cancel' | 'default' | 'destructive';
}

/** The prompt's words. "Sign out and discard" only after a drain attempt.
 *  With order requests not confirmed, the prompt says so (core's words) and
 *  offers "Don't send it and sign out". */
export function unsyncedPrompt(
  count: number,
  canDiscard: boolean,
  unconfirmedOrders = 0,
): { title: string; message: string; buttons: UnsyncedPromptButton[] } {
  const parts: string[] = [];
  let title = SIGN_OUT_UNCONFIRMED_TITLE_COPY;
  if (count > 0) {
    title = `${count} ${count === 1 ? 'change has' : 'changes have'} not synced`;
    const keep = 'If you sign out, they stay on this device and send the next time you sign in here.';
    parts.push(
      canDiscard
        ? `They could not be sent just now. ${keep}`
        : `This device is offline, so they could not be sent. ${keep}`,
    );
  }
  if (unconfirmedOrders > 0) {
    parts.push(`${signOutUnconfirmedOrdersCopy(unconfirmedOrders)} ${SIGN_OUT_UNCONFIRMED_HOLD_COPY}`);
  }
  const buttons: UnsyncedPromptButton[] = [{ choice: 'stay', label: SIGN_OUT_STAY_COPY, style: 'cancel' }];
  if (unconfirmedOrders > 0) {
    buttons.push({ choice: 'withdraw-orders', label: SIGN_OUT_WITHDRAW_COPY, style: 'default' });
  }
  buttons.push({ choice: 'sign-out', label: SIGN_OUT_COPY, style: 'default' });
  if (canDiscard)
    buttons.push({ choice: 'discard', label: 'Sign out and discard', style: 'destructive' });
  return { title, message: parts.join(' '), buttons };
}

/** Shown when a session survives both sign-outs. */
export const STILL_SIGNED_IN_TITLE = 'Could not sign out';
export const STILL_SIGNED_IN_MESSAGE =
  'StockPilot could not reach the server to end your session, so you are still signed in. Nothing on this device was removed. Check your connection and try again.';
