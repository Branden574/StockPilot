import AsyncStorage from '@react-native-async-storage/async-storage';

import { OutboxOwnerUnknownError, type LiveScope } from './outbox-scope';
import { readDeviceAuthSession } from './supabase';
import { ACTIVE_ORG_STORAGE_KEY } from './workspace-keys';

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

export async function liveOutboxScope(): Promise<LiveScope> {
  const [orgId, userId] = await Promise.all([
    AsyncStorage.getItem(ACTIVE_ORG_STORAGE_KEY).catch(() => null),
    readSessionUserId(),
  ]);
  return { orgId: orgId || null, userId };
}

/**
 * The owner to STAMP on a row being queued now. Never null: this code writes no
 * legacy (NULL-owner) rows, which any account would adopt and send as its own.
 * The live account when one is readable, else the last one seen this run;
 * with neither, the write is refused (OutboxOwnerUnknownError) rather than
 * queued for nobody.
 */
export async function outboxWriteScope(): Promise<{ orgId: string | null; userId: string }> {
  const scope = await liveOutboxScope();
  const userId = scope.userId ?? lastSeenUserId;
  if (!userId) throw new OutboxOwnerUnknownError();
  return { orgId: scope.orgId, userId };
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
