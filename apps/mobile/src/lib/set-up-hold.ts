import { policyRequiresAuthenticator, type OrganizationMfaPolicy } from '@stockpilot/core';

import {
  readSetUpInputsForHold,
  setUpInputsForgetCount,
  setUpInputsView,
  subscribeSetUpInputs,
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
 *   'unknown' a check that answered could not tell: the organization's row
 *             could not be read (and no verified factor), or the read failed
 *             with an answer and nothing is kept for the workspace;
 *   null      the app: nothing is owed, or nothing could be read with no
 *             connection (a phone offline at its first start keeps working;
 *             the check runs once a connection exists).
 *
 * The factor list is the server's, read this run (set-up-inputs.ts), else
 * the stored session's copy, which auth-context hands in with each call. That
 * copy is read here only: it never reaches set-up-inputs.ts, whose answers
 * the queue trusts only from server reads.
 *
 * What the hold does to queued work: nothing is dropped. With the data hooks
 * handed nobody, the sync does not run; rows of a workspace that owes set-up
 * are held by the queue (outbox-scope.ts) and sent once the account has an
 * authenticator; the screen says how many are waiting (setUpHoldQueuedLine).
 *
 * A LEAF beside set-up-inputs.ts: core and pure modules only.
 */

export type SetUpHold = 'owed' | 'unknown' | null;

/** The session's user as auth-js stores it; only `id` and each factor's `status` are read. */
export interface SessionUserForSetUp {
  id?: string | null;
  factors?: readonly ({ readonly status?: string | null } | null | undefined)[] | null;
}

/** The workspace use-workspace.ts shows, and for whom. */
let shown: { userId: string | null; orgId: string | null } = { userId: null, orgId: null };
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
 * use-workspace.ts: the workspace it now shows for this account (null: none
 * shown). A switch from one workspace to another for the same account also
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
  lastRead: SetUpInputsView['lastRead'];
}): SetUpHold {
  const { inputs, membershipsFrom, hasVerified, lastRead } = input;
  if (!inputs) {
    // Read this run and the workspace is not in it: nothing is owed there;
    // the workspace load chooses another. Nothing kept: only a read that
    // failed with an answer is a reason to hold.
    if (membershipsFrom === 'this-run') return null;
    return lastRead === 'failed' ? 'unknown' : null;
  }
  if (inputs.policy === 'hidden') {
    if (hasVerified) return null;
    // Read this run: the check answered and could not tell. Saved: only when
    // this run's read failed with an answer; offline, the app.
    if (membershipsFrom === 'this-run') return 'unknown';
    return lastRead === 'failed' ? 'unknown' : null;
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

export function setUpHoldDetails(
  sessionUser: SessionUserForSetUp | null | undefined,
): SetUpHoldDetails {
  const userId = typeof sessionUser?.id === 'string' && sessionUser.id ? sessionUser.id : null;
  if (!userId) return { hold: null, orgId: null, name: null, policy: null };
  const orgId = holdWorkspaceFor(userId);
  if (!orgId) return { hold: null, orgId: null, name: null, policy: null };
  const view = setUpInputsView(userId, orgId);
  const hold = decideSetUpHold({
    inputs: view.inputs,
    membershipsFrom: view.membershipsFrom,
    hasVerified: view.serverHasVerified ?? listHasVerified(sessionUser?.factors),
    lastRead: view.lastRead,
  });
  const read = view.inputs?.policy;
  const policy = read === 'admins_required' || read === 'all_required' ? read : null;
  return { hold, orgId, name: view.inputs?.name ?? null, policy };
}

/** The snapshot auth-context reads: a primitive, so useSyncExternalStore compares it. */
export function setUpHoldFor(sessionUser: SessionUserForSetUp | null | undefined): SetUpHold {
  return setUpHoldDetails(sessionUser).hold;
}

/**
 * Push while held: this phone's token row is deleted once each time the hold
 * comes up for an account (the push hook, handed nobody, would otherwise
 * leave an earlier registration receiving). On release the push hook is
 * handed the user again and registers this phone again by itself.
 */
export function createHoldPushUnbinder(unbind: () => unknown): {
  update(heldUserId: string | null): void;
} {
  let heldFor: string | null = null;
  return {
    update(heldUserId) {
      if (heldUserId === heldFor) return;
      heldFor = heldUserId;
      if (!heldUserId) return;
      try {
        void Promise.resolve(unbind()).catch(() => undefined);
      } catch {
        // Never a reason for the hold to fail.
      }
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
  savedRead = null;
  listeners.clear();
}
