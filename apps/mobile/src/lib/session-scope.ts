import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  OutboxOwnerUnknownError,
  OutboxWorkspaceLoadingError,
  type LiveScope,
} from './outbox-scope';
import { readDeviceAuthSession } from './supabase';
import { ownSavedWorkspace, readSavedWorkspace, type SavedWorkspace } from './workspace-keys';

/**
 * The workspace and account live on the device right now, for the outbox
 * (outbox-scope.ts): the saved workspace (workspace-keys.ts: the one
 * use-workspace.ts saves and api.ts orgHeader() names) and the account whose
 * session is PERSISTED here.
 *
 * The account is read from the stored session, never from
 * supabase.auth.getSession(). getSession() refreshes an expiring token first,
 * and offline that refresh fails after about 25 s with the session still
 * stored while the answer says "no session" (auth-storage.ts). An operator
 * counting offline for more than an hour then looked signed out: new rows were
 * stamped with no owner (adoptable by the next account), their own rows fell
 * out of every counter and showed as another account's, and every save waited
 * on the auth lock. The stored session answers at once, and only a real end of
 * the session (a sign-out, or a refresh the server refused) removes it.
 *
 * Read per call, never cached for decisions: a workspace switch or a sign-out
 * can land between two rows of one drain. api() still checks the bearer's
 * account at the moment it sends (asUserId), so reading the stored session
 * here never lets a row out under the wrong account.
 */

/**
 * The last account seen holding the session this app run. Used ONLY to stamp a
 * row written just after that session ended (the count screen saving what was
 * typed as it unmounts on an involuntary sign-out): the person who typed it is
 * the account that was signed in, and a row with no owner would be adopted and
 * sent by whoever signs in next.
 */
let lastSeenUserId: string | null = null;

/** The stored session's account; null when nobody is signed in or it cannot be read now. */
async function readSessionUserId(): Promise<string | null> {
  try {
    const { userId } = await readDeviceAuthSession();
    if (userId) lastSeenUserId = userId;
    return userId;
  } catch {
    // Unreadable reads as nobody: every row is held, nothing is sent on a guess.
    return null;
  }
}

const NOTHING_SAVED: SavedWorkspace = { orgId: null, ownerId: null };

/** The saved workspace (a storage fault reads as nothing saved) and the stored session's account. */
async function readLive(): Promise<{ saved: SavedWorkspace; userId: string | null }> {
  const [saved, userId] = await Promise.all([
    readSavedWorkspace(AsyncStorage).catch(() => NOTHING_SAVED),
    readSessionUserId(),
  ]);
  return { saved, userId };
}

export async function liveOutboxScope(): Promise<LiveScope> {
  const { saved, userId } = await readLive();
  // Only a workspace this account saved itself (workspace-keys.ts
  // ownSavedWorkspace; docket B10, integrator decision 3). The drains send a
  // row that has no organization of its own (a legacy row, or one queued
  // before any workspace was saved) under it, and HOLD that row while it is
  // null (outbox-scope.ts 'workspace-loading'): nothing saved, another
  // account's, or an older build's record with no owner, which may be another
  // account's choice. Before, such a row went out with no workspace header at
  // all and the server applied it in the account's default organization.
  // Signed out, the owner is the account last seen this run, the one a row
  // written now is queued for.
  return { orgId: ownSavedWorkspace(saved, userId ?? lastSeenUserId), userId };
}

/**
 * The owner and workspace to STAMP on a row being queued now.
 *
 * The owner is never null: this code writes no legacy (NULL-owner) rows, which
 * any account would adopt and send as its own. The live account when one is
 * readable, else the last one seen this run; with neither, the write is
 * refused (OutboxOwnerUnknownError) rather than queued for nobody.
 *
 * The workspace is the one that owner saved itself (ownSavedWorkspace). While
 * the saved workspace is ANOTHER account's (the moment after a different
 * account signs in, before its workspace load saves its own choice, or longer
 * when that load fails offline), or an older build's with no owner (until
 * this build's first workspace load records it: integrator decision 3), the
 * write is refused too (OutboxWorkspaceLoadingError: try again in a moment).
 * Stamped with no workspace, the row would be sent under whichever workspace
 * this account saves next, after a switch not the one the change was made in
 * (S4a); stamped with another account's, the server refuses it and the change
 * is lost, or, where this account is a member there too, it lands in a
 * workspace this account did not choose. Nothing saved (a fresh
 * install before its first workspace load) stamps none, as before: such a
 * row is held until this account's workspace is saved, then sent under it
 * (outbox-scope.ts 'workspace-loading').
 */
export async function outboxWriteScope(): Promise<{ orgId: string | null; userId: string }> {
  const { saved, userId: live } = await readLive();
  const userId = live ?? lastSeenUserId;
  if (!userId) throw new OutboxOwnerUnknownError();
  if (!saved.orgId) return { orgId: null, userId };
  const orgId = ownSavedWorkspace(saved, userId);
  if (!orgId) throw new OutboxWorkspaceLoadingError();
  return { orgId, userId };
}

/**
 * Is a session still on this device? The sign-out flows read this back after
 * signOut() to decide whether it really ended (sign-out-flow.ts endSession).
 * REJECTS when storage cannot be read, which endSession treats as "still
 * signed in": nothing is wiped and no lock is lifted on a guess.
 */
export async function hasStoredSession(): Promise<boolean> {
  return (await readDeviceAuthSession()).present;
}

/** The account last seen holding the session this run (see lastSeenUserId). */
export function lastSeenSessionUserId(): string | null {
  return lastSeenUserId;
}
