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
 *   6. only once it is gone: discard (if chosen) and clear the cache. The
 *      outbox is never cleared by a sign-out.
 *
 * Pure: every effect is injected, so the order can be executed in vitest (the
 * React Native auth context cannot load there).
 */

export type UnsyncedChoice = 'stay' | 'sign-out' | 'discard';

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

export interface SignOutFlowDeps extends EndSessionDeps {
  /** This account's queued changes not yet on the server (pending/failed/sending). */
  countUnsynced(): Promise<number>;
  isOnline(): Promise<boolean>;
  /** Try to send them now (both drains). Bounded by the flow. */
  drain(): Promise<void>;
  confirmUnsynced(count: number, opts: { canDiscard: boolean }): Promise<UnsyncedChoice>;
  /** Stamp this account's legacy rows (NULL owner) as its own. */
  holdForAccount(): Promise<void>;
  /** Delete this account's unsynced rows (only after the session is gone). */
  discardUnsynced(): Promise<void>;
  /** Clear the org-scoped cache. Never touches the outbox. */
  wipeCache(): Promise<void>;
}

/** How long the sign-out waits for the drains before asking anyway. */
export const SIGN_OUT_DRAIN_TIMEOUT_MS = 15_000;

/**
 * End the session and report whether it actually ended. `global` falls back
 * to `local` on an error. The answer is read back from the session, not
 * inferred from the calls: a transport failure keeps the session whatever the
 * scope. A throw is an error; an unreadable session counts as still present
 * (fail closed: nothing is wiped and no lock is lifted on a guess).
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

  let discard = opts.discardWithoutAsking === true;
  if (!discard) {
    let unsynced = await count();
    let drained = false;
    if (unsynced > 0 && (await deps.isOnline().catch(() => false))) {
      await withTimeout(deps.drain(), opts.drainTimeoutMs ?? SIGN_OUT_DRAIN_TIMEOUT_MS).catch((e) =>
        warn('[auth] pre-sign-out sync failed', e),
      );
      drained = true;
      unsynced = await count();
    }
    if (unsynced > 0) {
      const choice = await deps.confirmUnsynced(unsynced, { canDiscard: drained });
      if (choice === 'stay') return 'stayed';
      // Discard exists only after a real attempt to send (D5).
      discard = choice === 'discard' && drained;
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

/** The prompt's words. "Sign out and discard" only after a drain attempt. */
export function unsyncedPrompt(
  count: number,
  canDiscard: boolean,
): { title: string; message: string; buttons: UnsyncedPromptButton[] } {
  const title = `${count} ${count === 1 ? 'change has' : 'changes have'} not synced`;
  const keep =
    'If you sign out, they stay on this device and send the next time you sign in here.';
  const message = canDiscard
    ? `They could not be sent just now. ${keep}`
    : `This device is offline, so they could not be sent. ${keep}`;
  const buttons: UnsyncedPromptButton[] = [
    { choice: 'stay', label: 'Stay signed in', style: 'cancel' },
    { choice: 'sign-out', label: 'Sign out', style: 'default' },
  ];
  if (canDiscard) buttons.push({ choice: 'discard', label: 'Sign out and discard', style: 'destructive' });
  return { title, message, buttons };
}

/** Shown when a session survives both sign-outs. */
export const STILL_SIGNED_IN_TITLE = 'Could not sign out';
export const STILL_SIGNED_IN_MESSAGE =
  'StockPilot could not reach the server to end your session, so you are still signed in. Nothing on this device was removed. Check your connection and try again.';
