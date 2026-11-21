import AsyncStorage from '@react-native-async-storage/async-storage';

import { PROBE_TIMEOUT_MS, withTimeout } from './account-eviction';
import { handOverLiveUser } from './mfa-reconcile';
import { noteSavedHoldWorkspace } from './set-up-hold';
import {
  beginSetUpRead,
  noteServerReadUser,
  noteSetUpReadOutcome,
  registerSetUpInputsSource,
} from './set-up-inputs';
import { supabase } from './supabase';
import { loadOrgs } from './use-workspace';
import { readSavedWorkspace } from './workspace-keys';

/**
 * Connects set-up-inputs.ts (a leaf) to the app: AsyncStorage for the saved
 * inputs, and the read the queued-work hold and the holding screen ask for;
 * and set-up-hold.ts to the saved workspace. Called once by use-sync.ts,
 * which the root layout loads at start.
 */

/** How long the membership read waits, as a workspace load does (use-workspace.ts). */
const MEMBERSHIP_READ_TIMEOUT_MS = 15_000;

/**
 * The account's factor list from the server, then its memberships with each
 * workspace's policy (loadOrgs hands those to set-up-inputs.ts). Both
 * bounded: React Native's fetch has no timeout, and a read that never ended
 * would stop every later one. The user is handed to the code gate's
 * reconcile too (mfa-reconcile.ts), as every server read of the user is.
 *
 * How it ended is recorded for the holding screen: loadOrgs records an
 * answer or a failure itself; here, a user read that failed (for
 * `forUserId`, the account the screen reads for) and a membership read that
 * did not end in time. The number is taken before any request starts.
 */
async function readSetUpInputsNow(forUserId?: string | null): Promise<void> {
  const readSeq = beginSetUpRead();
  const answer = await withTimeout(
    supabase.auth.getUser().then(handOverLiveUser),
    PROBE_TIMEOUT_MS,
    null,
  );
  const user = answer && !answer.error ? answer.data.user : null;
  if (!user) {
    noteSetUpReadOutcome(forUserId, readSeq, answeredWithError(answer) ? 'failed' : 'no-answer');
    return;
  }
  noteServerReadUser(user, readSeq);
  const orgs = await withTimeout(loadOrgs(user.id), MEMBERSHIP_READ_TIMEOUT_MS, null);
  // A read that ended, answered or failed, is recorded by loadOrgs under its
  // own later number, which this one never replaces.
  if (orgs === null) noteSetUpReadOutcome(user.id, readSeq, 'no-answer');
}

/** A user read the server answered with an error (auth-js gives a network failure status 0). */
function answeredWithError(answer: { error: unknown } | null): boolean {
  const status = (answer?.error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && status > 0;
}

let connected = false;

/** Once per app run; later calls do nothing. */
export function connectSetUpInputs(): void {
  if (connected) return;
  connected = true;
  void registerSetUpInputsSource({ storage: AsyncStorage, read: readSetUpInputsNow });
  // The workspace the holding screen checks before a workspace load shows one
  // (a cold start offline shows none).
  void readSavedWorkspace(AsyncStorage).then(noteSavedHoldWorkspace, () => undefined);
}
