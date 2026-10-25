import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  OutboxOwnerUnknownError,
  OutboxWorkspaceLoadingError,
  type LiveScope,
} from './outbox-scope';
import { readDeviceAuthSession } from './supabase';
import { readSavedWorkspace, savedWorkspaceFor, type SavedWorkspace } from './workspace-keys';

/**
 * The workspace and account live on the device right now, for the outbox
 * (outbox-scope.ts): the saved workspace (the key use-workspace.ts writes and
 * api.ts orgHeader() sends) and the account whose session is PERSISTED here.
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
  // Only the account's own saved workspace (workspace-keys.ts
  // savedWorkspaceFor), as api() names it (docket B10): the drains send a row
  // that has no organization of its own (a legacy row) under it, never under
  // another account's. A new row is not queued at all while the saved
  // workspace is another account's (outboxWriteScope). Signed out, the owner
  // is the account last seen this run, the one a row written now is queued
  // for.
  return { orgId: savedWorkspaceFor(saved, userId ?? lastSeenUserId), userId };
}

/**
 * The owner and workspace to STAMP on a row being queued now.
 *
 * The owner is never null: this code writes no legacy (NULL-owner) rows, which
 * any account would adopt and send as its own. The live account when one is
 * readable, else the last one seen this run; with neither, the write is
 * refused (OutboxOwnerUnknownError) rather than queued for nobody.
 *
 * The workspace is the one that owner saved (savedWorkspaceFor). While the
 * saved workspace is ANOTHER account's (the moment after a different account
 * signs in, before its workspace load saves its own choice, or longer when
 * that load fails offline), the write is refused too
 * (OutboxWorkspaceLoadingError: try again in a moment). Stamped with no
 * workspace, the row would be sent under whichever one is saved when it is
 * sent, after a switch the wrong one (S4a); stamped with the other account's,
 * the server refuses it and the change is lost. Nothing saved (a fresh
 * install before its first workspace load) stamps none, and a workspace saved
 * by an older build (no owner) is stamped, both as before.
 */
export async function outboxWriteScope(): Promise<{ orgId: string | null; userId: string }> {
  const { saved, userId: live } = await readLive();
  const userId = live ?? lastSeenUserId;
  if (!userId) throw new OutboxOwnerUnknownError();
  const orgId = savedWorkspaceFor(saved, userId);
  if (saved.orgId && !orgId) throw new OutboxWorkspaceLoadingError();
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
