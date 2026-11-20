import { policyRequiresAuthenticator, type OrganizationMfaPolicy } from '@stockpilot/core';

import {
  keptWorkspacesFor,
  readSetUpInputsForHold,
  setUpInputsForgetCount,
  setUpInputsView,
  subscribeSetUpInputs,
  type KeptWorkspace,
  type SetUpInputsView,
} from './set-up-inputs';
import { savedWorkspaceFor, type SavedWorkspace } from './workspace-keys';

/** The holding screen's read (set-up-inputs.ts), for the provider and the screen. */
export { readSetUpInputsForHold };

/**
 * THE HOLDING SCREEN'S DECISION: does the app open, or does the set-up
 * screen (authenticator-set-up-screen.tsx) take its place?
 *
 * A courtesy for the person: the server decides what it answers whatever
 * this says. auth-context.tsx reads it with
 * `useSyncExternalStore(subscribeSetUpHold, () => setUpHoldFor(session.user))`
 * and hands RootGate `useAuth().setUpHold`.
 *
 * For the signed-in account, in the workspace the app shows it (published by
 * use-workspace.ts), else in its saved workspace (the one api.ts names):
 *   'owed'    the organization's policy, as read, asks this role for an
 *             authenticator and the account has no verified one;
 *   'unknown' a membership read that ANSWERED this run could not be judged:
 *             the organization's row could not be read, or its policy is not
 *             one the app knows (and no verified factor);
 *   null      the app: nothing is owed, nothing is kept for the workspace, or
 *             what is kept could not be judged and nothing answered this run.
 *             A read that failed, with an error answer or with none, counts
 *             as no answer: the app, and the read is tried again every
 *             SET_UP_RECHECK_INTERVAL_MS (auth-context.tsx) until one answers.
 *
 * The factor list is the server's, read this run (set-up-inputs.ts), else
 * the stored session's copy, which auth-context hands in with each call (and
 * notes here for the callers outside React: noteHoldSessionUser). That copy
 * is read here only: it never reaches set-up-inputs.ts, whose answers the
 * queue trusts only from server reads.
 *
 * What the hold does to queued work: nothing is dropped. No snapshot pull
 * runs while it is up (sync.ts pullSnapshot asks setUpHoldIn), whatever asks
 * for one. The two drains keep their per-row rule (outbox-scope.ts): rows of
 * the held workspace wait while it answers 'owed' and are sent once the
 * account has an authenticator; in 'unknown' they are tried, and a row the
 * server refuses for want of an authenticator stays queued. Rows of another
 * workspace are sent as usual. The screen says how many of the held
 * workspace's rows are waiting (setUpHoldQueuedLine).
 *
 * A LEAF beside set-up-inputs.ts: core and pure modules only.
 */

export type SetUpHold = 'owed' | 'unknown' | null;

/** The session's user as auth-js stores it; only `id` and each factor's `status` are read. */
export interface SessionUserForSetUp {
  id?: string | null;
  factors?: readonly ({ readonly status?: string | null } | null | undefined)[] | null;
}

/** The workspace use-workspace.ts shows (or has just chosen), and for whom. */
let shown: { userId: string | null; orgId: string | null } = { userId: null, orgId: null };
/** The session's user as auth-context last rendered it (noteHoldSessionUser). */
let sessionUser: SessionUserForSetUp | null = null;
/** The saved workspace as read at start, with the sign-out count it was read at. */
let savedRead: { saved: SavedWorkspace; forgetCount: number } | null = null;

const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A listener's own failure is its own.
    }
  }
}

/** Told after every change that can move the decision (the store's and the workspace's). */
export function subscribeSetUpHold(fn: () => void): () => void {
  listeners.add(fn);
  const stopInputs = subscribeSetUpInputs(fn);
  return () => {
    listeners.delete(fn);
    stopInputs();
  };
}

/**
 * use-workspace.ts: the workspace it shows for this account (null: none
 * shown), told as soon as a load has chosen it and again with every publish,
 * always before the screens are. A switch from one workspace to another for the same account also
 * reads the inputs again (the new workspace's policy may have changed since
 * the memberships were read).
 */
export function noteHoldWorkspace(userId: string | null, orgId: string | null): void {
  if (shown.userId === userId && shown.orgId === orgId) return;
  const switched =
    userId !== null && shown.userId === userId && shown.orgId !== null && orgId !== null;
  shown = { userId, orgId };
  changed();
  if (switched) void readSetUpInputsForHold(userId);
}

/** The saved workspace, read once at start (set-up-inputs-source.ts). */
export function noteSavedHoldWorkspace(saved: SavedWorkspace): void {
  savedRead = { saved, forgetCount: setUpInputsForgetCount() };
  changed();
}

/** The workspace held for this account: the one shown for it, else its saved one. */
function holdWorkspaceFor(userId: string): string | null {
  if (shown.userId === userId && shown.orgId) return shown.orgId;
  // A sign-out since the read removed the saved workspace with the account's keys.
  if (!savedRead || savedRead.forgetCount !== setUpInputsForgetCount()) return null;
  return savedWorkspaceFor(savedRead.saved, userId);
}

/** Whether a factor list (the session's copy) has a verified factor. */
function listHasVerified(list: SessionUserForSetUp['factors']): boolean {
  return Array.isArray(list) && list.some((f) => f?.status === 'verified');
}

/** THE RULE, from what is kept (see the file header and the states table in the PR). */
export function decideSetUpHold(input: {
  inputs: SetUpInputsView['inputs'];
  membershipsFrom: SetUpInputsView['membershipsFrom'];
  hasVerified: boolean;
}): SetUpHold {
  const { inputs, membershipsFrom, hasVerified } = input;
  // Nothing kept for the workspace (or the read this run does not hold it:
  // the workspace load chooses another): the app, however the last read ended.
  if (!inputs) return null;
  if (inputs.policy === 'hidden') {
    if (hasVerified) return null;
    // Answered this run and could not be judged: could-not-check. Saved by an
    // earlier run: the app until a read answers this run.
    return membershipsFrom === 'this-run' ? 'unknown' : null;
  }
  if (!policyRequiresAuthenticator(inputs.policy, inputs.role)) return null;
  return hasVerified ? null : 'owed';
}

/** What the screen shows: the decision, and the workspace's name and policy as read. */
export interface SetUpHoldDetails {
  hold: SetUpHold;
  orgId: string | null;
  /** The workspace's name as read; null for a row that could not be read. */
  name: string | null;
  /** The policy as read when it asks for an authenticator; null otherwise. */
  policy: Exclude<OrganizationMfaPolicy, 'optional'> | null;
}

const NOTHING_HELD: SetUpHoldDetails = { hold: null, orgId: null, name: null, policy: null };

function idOf(user: SessionUserForSetUp | null | undefined): string | null {
  return typeof user?.id === 'string' && user.id ? user.id : null;
}

/** The decision for one account in one workspace, with the session's factor list for that account. */
function detailsIn(
  userId: string,
  orgId: string | null,
  sessionFactors: SessionUserForSetUp['factors'],
): SetUpHoldDetails {
  if (!orgId) return NOTHING_HELD;
  const view = setUpInputsView(userId, orgId);
  const hold = decideSetUpHold({
    inputs: view.inputs,
    membershipsFrom: view.membershipsFrom,
    hasVerified: view.serverHasVerified ?? listHasVerified(sessionFactors),
  });
  const read = view.inputs?.policy;
  const policy = read === 'admins_required' || read === 'all_required' ? read : null;
  return { hold, orgId, name: view.inputs?.name ?? null, policy };
}

export function setUpHoldDetails(
  sessionUser: SessionUserForSetUp | null | undefined,
): SetUpHoldDetails {
  const userId = idOf(sessionUser);
  if (!userId) return NOTHING_HELD;
  return detailsIn(userId, holdWorkspaceFor(userId), sessionUser?.factors);
}

/** The snapshot auth-context reads: a primitive, so useSyncExternalStore compares it. */
export function setUpHoldFor(sessionUser: SessionUserForSetUp | null | undefined): SetUpHold {
  return setUpHoldDetails(sessionUser).hold;
}

/**
 * auth-context.tsx: the session's user, for the callers outside React (the
 * snapshot pull, the workspace load and switch, push registration). Never
 * reaches set-up-inputs.ts. Tells nobody: those callers ask when they run.
 */
export function noteHoldSessionUser(user: SessionUserForSetUp | null | undefined): void {
  sessionUser = user ?? null;
}

/**
 * The decision for code outside React: this account in `orgId` (by default
 * the workspace held for it), with the session's factor list when the
 * session noted is this account's. The same rule the screen is shown by.
 * The code step is not part of it: each caller already holds for that first.
 */
export function setUpHoldIn(userId: string | null | undefined, orgId?: string | null): SetUpHold {
  if (typeof userId !== 'string' || !userId) return null;
  const factors = idOf(sessionUser) === userId ? sessionUser?.factors : undefined;
  return detailsIn(userId, orgId === undefined ? holdWorkspaceFor(userId) : orgId, factors).hold;
}

/** Whether the latest read for this account answered (the holding screen's line after Check again). */
export function setUpCheckAnswered(sessionUser: SessionUserForSetUp | null | undefined): boolean {
  const userId = idOf(sessionUser);
  return userId !== null && setUpInputsView(userId, null).lastRead === 'answered';
}

/** How often the set-up check is read again on its own (auth-context.tsx), while setUpRecheckDue. */
export const SET_UP_RECHECK_INTERVAL_MS = 30_000;

/**
 * Whether the check is read again on a timer for this account: nothing has
 * answered this run (a read that failed, with an error or with no answer,
 * leaves the app open, and is tried again until one answers), or the
 * could-not-check hold is up.
 */
export function setUpRecheckDue(sessionUser: SessionUserForSetUp | null | undefined): boolean {
  const userId = idOf(sessionUser);
  if (!userId) return false;
  if (setUpHoldFor(sessionUser) === 'unknown') return true;
  return setUpInputsView(userId, null).membershipsFrom !== 'this-run';
}

/**
 * The organizations the holding screen offers to switch to: those kept for
 * the account, from the same reads as the decision. Organizations only (no
 * workspace load runs for the list, and nothing of a workspace's contents
 * is read for it). The same array until what is kept changes.
 */
export function setUpHoldWorkspaces(
  sessionUser: SessionUserForSetUp | null | undefined,
): readonly KeptWorkspace[] {
  return keptWorkspacesFor(idOf(sessionUser));
}

/** What an unbind answers (push-unbind.ts unbindThisDevice): these three end the attempts. */
const UNBIND_SETTLED: ReadonlySet<unknown> = new Set(['deleted', 'none', 'nothing-registered']);

/**
 * Push while held: this phone's token row is deleted each time the hold
 * comes up for an account (the push hook, handed nobody, would otherwise
 * leave an earlier registration receiving). An unbind that did not answer
 * 'deleted', 'none' or 'nothing-registered' (no connection, no answer in
 * time, a failure) is tried again at `retry()` while the hold is still up for
 * that account (auth-context calls it at each read, the return to the
 * foreground and the connection coming back). One attempt at a time. On
 * release the push hook is handed the user again and registers this phone
 * again by itself.
 */
export function createHoldPushUnbinder(unbind: () => unknown): {
  update(heldUserId: string | null): void;
  retry(): void;
} {
  let heldFor: string | null = null;
  /** Bumped at every change of the hold: an answer belongs to the hold it was asked for. */
  let generation = 0;
  let settled = false;
  let running = false;
  const attempt = () => {
    if (!heldFor || settled || running) return;
    const askedAt = generation;
    running = true;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(unbind());
    } catch {
      result = Promise.resolve(undefined);
    }
    void result
      .catch(() => undefined)
      .then((answer) => {
        running = false;
        if (askedAt === generation) {
          if (UNBIND_SETTLED.has(answer)) settled = true;
          return;
        }
        // The hold changed meanwhile (another account, or a release and a
        // new hold): the hold that is up gets its own attempt.
        attempt();
      });
  };
  return {
    update(heldUserId) {
      if (heldUserId === heldFor) return;
      heldFor = heldUserId;
      generation += 1;
      settled = false;
      attempt();
    },
    retry() {
      attempt();
    },
  };
}

/** The holding screen's line about changes on this phone that have not been sent; null for none. */
export function setUpHoldQueuedLine(hold: Exclude<SetUpHold, null>, count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const one = count === 1;
  const head = `${count} ${one ? 'change has' : 'changes have'} not synced.`;
  if (hold === 'owed') {
    return one
      ? `${head} It stays on this phone and is sent after you set up your authenticator.`
      : `${head} They stay on this phone and are sent after you set up your authenticator.`;
  }
  return one
    ? `${head} It stays on this phone until it can be sent.`
    : `${head} They stay on this phone until they can be sent.`;
}

/** Tests only. */
export function resetSetUpHoldForTests(): void {
  shown = { userId: null, orgId: null };
  sessionUser = null;
  savedRead = null;
  listeners.clear();
}
