import AsyncStorage from '@react-native-async-storage/async-storage';

import { PROBE_TIMEOUT_MS, withTimeout } from './account-eviction';
import { handOverLiveUser } from './mfa-reconcile';
import { beginSetUpRead, noteServerReadUser, registerSetUpInputsSource } from './set-up-inputs';
import { supabase } from './supabase';
import { loadOrgs } from './use-workspace';

/**
 * Connects set-up-inputs.ts (a leaf) to the app: AsyncStorage for the saved
 * inputs, and the read the queued-work hold asks for. Called once by
 * use-sync.ts, which the root layout loads at start.
 */

/** How long the membership read waits, as a workspace load does (use-workspace.ts). */
const MEMBERSHIP_READ_TIMEOUT_MS = 15_000;

/**
 * The account's factor list from the server, then its memberships with each
 * workspace's policy (loadOrgs hands those to set-up-inputs.ts). Both
 * bounded: React Native's fetch has no timeout, and a read that never ended
 * would stop every later one. The user is handed to the code gate's
 * reconcile too (mfa-reconcile.ts), as every server read of the user is.
 */
async function readSetUpInputsNow(): Promise<void> {
  const readSeq = beginSetUpRead();
  const answer = await withTimeout(
    supabase.auth.getUser().then(handOverLiveUser),
    PROBE_TIMEOUT_MS,
    null,
  );
  const user = answer && !answer.error ? answer.data.user : null;
  if (!user) return;
  noteServerReadUser(user, readSeq);
  await withTimeout(loadOrgs(user.id), MEMBERSHIP_READ_TIMEOUT_MS, null);
}

let connected = false;

/** Once per app run; later calls do nothing. */
export function connectSetUpInputs(): void {
  if (connected) return;
  connected = true;
  void registerSetUpInputsSource({ storage: AsyncStorage, read: readSetUpInputsNow });
}
