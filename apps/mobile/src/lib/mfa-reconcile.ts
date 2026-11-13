import { stepUpOwed } from '@stockpilot/core';

import { reconcileStepUp, stepUpOwedFor, tokenAal, type SessionLike, type UserLike } from './mfa-level';

/**
 * KEEPING THE CODE GATE IN STEP WITH THE SERVER.
 *
 * The gate reads the session's own copy of the user (mfa-level.ts), and that
 * copy is as old as the last sign-in or token refresh. Two things change on
 * the server without this phone hearing of it:
 *   - an authenticator is turned on elsewhere while this phone is signed in:
 *     the session owes a code its copy does not know about yet;
 *   - an authenticator is removed (a reset, a recovery code): the session's
 *     copy still lists a factor nobody can answer for.
 *
 * Whenever the app reads the user from the server anyway (the cold-launch
 * probe, the probe after a refused request, the return to the foreground, the
 * code screen appearing), that answer is handed here. When it disagrees with
 * the session's copy, the session is refreshed: a refresh replaces the stored
 * user, so the gate and the outbox hold (session-scope.ts) both follow.
 *
 * ONE DIRECTION IS NEVER TAKEN ON TRUST. The gate comes DOWN only through a
 * session the server issued (a refresh that worked). It goes UP at once: when
 * the server lists a verified factor and the refresh could not be made, the
 * account is noted here (`forcedFor`) and the gate reads that note until a
 * refresh, a verified code or a sign-out settles it.
 *
 * THE NOTE IS NEVER KEPT FOR A SESSION AT aal2. That session entered its
 * code, which is what the note asks for. Every reader of the note ignores it
 * for such a session (mfa-level.ts stepUpNoteHolds: the gate, the outbox
 * hold, push registration), and the reconcile withdraws it: at the start of
 * a run, and again right after raising it, because the refresh a run waits
 * on can end after the code was entered.
 *
 * No react-native and no supabase client: auth-context.tsx supplies the two
 * calls and reads the note for the gate; session-scope.ts (the outbox hold)
 * and use-push-notifications.ts (push registration) read it too.
 */

// ── The note: the account whose session owes a code its copy does not show ──

let forcedFor: string | null = null;
const listeners = new Set<() => void>();

/** The account noted as owing its code (see above), or null. */
export function stepUpForcedFor(): string | null {
  return forcedFor;
}

export function setStepUpForcedFor(userId: string | null): void {
  if (forcedFor === userId) return;
  forcedFor = userId;
  for (const listener of [...listeners]) listener();
}

/** For useSyncExternalStore: AuthProvider re-renders when the note changes. */
export function subscribeStepUpForced(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── The hand-over: a user the app just read from the server ────────────────

let liveUserHandler: ((user: UserLike) => void) | null = null;

/**
 * Registered by AuthProvider. A plain module in between, so the account gate
 * (use-account-gate.ts) can hand over what its probe read without importing
 * the provider.
 */
export function setLiveUserHandler(handler: ((user: UserLike) => void) | null): void {
  liveUserHandler = handler;
}

/**
 * Pass a getUser() answer through, handing its user over when it has one.
 * Returns the answer untouched, so it drops into a promise chain:
 * `supabase.auth.getUser().then(handOverLiveUser)`. An answer with an error,
 * or with no user, hands nothing over: it says nothing about the factors.
 * Never throws into the chain it sits in.
 */
export function handOverLiveUser<T>(answer: T): T {
  try {
    const res = answer as { data?: { user?: UserLike | null } | null; error?: unknown } | null;
    const user = res?.data?.user;
    if (user && !res?.error && liveUserHandler) liveUserHandler(user);
  } catch (e) {
    console.warn('[auth] could not hand over the live user', e);
  }
  return answer;
}

// ── The reconcile ──────────────────────────────────────────────────────────

export interface StepUpReconcileDeps {
  /** The session auth-js holds now, or null. Never throws. */
  currentSession: () => Promise<SessionLike | null>;
  /**
   * Refresh the session: the refreshed session, or null when the refresh
   * failed, was refused or did not answer in time. A throw is read as null.
   */
  refreshSession: () => Promise<SessionLike | null>;
}

/**
 * What one reconcile did:
 *   'none'      the session and the server agree, the answer is not about
 *               this session's account, or the session is at aal2 (it owes
 *               nothing, and a note about it is withdrawn);
 *   'refreshed' they disagreed and a refresh brought the session up to date;
 *   'forced'    the server lists a verified factor, the session's copy does
 *               not, and no refresh could show it: the gate is held up;
 *   'kept'      the server lists none, the session's copy does, and the
 *               refresh failed: the gate stays as it is.
 */
export type StepUpReconcileOutcome = 'none' | 'refreshed' | 'forced' | 'kept';

/**
 * One reconciler per app: runs are single-flight (a second user handed over
 * while one runs joins that run), so a burst of probes makes one refresh.
 */
export function createStepUpReconciler(
  deps: StepUpReconcileDeps,
): (liveUser: UserLike | null | undefined) => Promise<StepUpReconcileOutcome> {
  let running: Promise<StepUpReconcileOutcome> | null = null;

  /**
   * Raise the gate on the server's word, at once, then read the session
   * again. The refresh this run waited on (up to its bound) can end after the
   * code was entered: a session that reached aal2 meanwhile owes nothing, so
   * the note is withdrawn. Set first and read second: a code verified after
   * the note is set clears it itself (auth-context.tsx), so no order of the
   * two leaves a note on a session at aal2. A read that fails keeps the note.
   */
  async function raise(userId: string): Promise<StepUpReconcileOutcome> {
    setStepUpForcedFor(userId);
    let now: SessionLike | null = null;
    try {
      now = await deps.currentSession();
    } catch {
      now = null;
    }
    if (now?.user?.id === userId && tokenAal(now.access_token) === 'aal2') {
      if (forcedFor === userId) setStepUpForcedFor(null);
      return 'none';
    }
    return 'forced';
  }

  async function run(liveUser: UserLike | null | undefined): Promise<StepUpReconcileOutcome> {
    const session = await deps.currentSession();
    const userId = session?.user?.id;
    if (!session || !userId || !liveUser || liveUser.id !== userId) return 'none';

    const level = tokenAal(session.access_token);
    // A session at aal2 entered its code. It owes nothing whatever factors
    // the server lists, and a note about it has been answered.
    if (level === 'aal2') {
      if (forcedFor === userId) setStepUpForcedFor(null);
      return 'none';
    }

    const live = stepUpOwed(liveUser.factors, level);
    // A note for this account that the server no longer backs is settled the
    // same way as a stale copy: by a refresh, never by dropping it here.
    const staleNote = forcedFor === userId && !live;
    if (reconcileStepUp(session, liveUser) === 'none' && !staleNote) return 'none';

    // A refresh that throws is a refresh that failed: it must end in the same
    // place, never in a run that gives up before the gate is raised.
    let refreshed: SessionLike | null = null;
    try {
      refreshed = await deps.refreshSession();
    } catch {
      refreshed = null;
    }
    if (!refreshed || refreshed.user?.id !== userId) {
      if (!live) return 'kept';
      return raise(userId);
    }
    // The server issued this session, so its copy is the server's. Should it
    // still not show the factor the server just listed, the gate stays up.
    if (live && !stepUpOwedFor(refreshed) && tokenAal(refreshed.access_token) !== 'aal2') {
      return raise(userId);
    }
    if (forcedFor === userId) setStepUpForcedFor(null);
    return 'refreshed';
  }

  return (liveUser) => {
    running ??= run(liveUser)
      .catch((e): StepUpReconcileOutcome => {
        console.warn('[auth] code gate reconcile failed', e);
        return 'none';
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}
