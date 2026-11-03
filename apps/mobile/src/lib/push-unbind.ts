import * as Notifications from 'expo-notifications';

import { supabase } from './supabase';
import {
  holdRegistration,
  registerThisDevice,
  registrationSettled,
  releaseRegistration,
  rememberedPushToken,
} from './use-push-notifications';

import type { User } from '@supabase/supabase-js';

/**
 * A signed-out phone stops getting the account's notifications (S5,
 * plans/S5.md 3.3).
 *
 * THE DEFECT. Nothing on the phone ever deleted its push_tokens row. A
 * deliberate sign-out ended the session and left the row bound to the
 * account, so a shared or handed-on phone kept showing that account's
 * purchase order, order and stock notifications on its lock screen for up to
 * 120 days (the dispatch window, 0028/0313), until someone else registered
 * the same phone. DELETE /api/v1/push/register said it "Lets the mobile app
 * deregister on sign-out"; nothing in the app called it.
 *
 * NOW. Every deliberate sign-out deletes this phone's row while the session
 * (and the access token the delete needs) still exists, by the token it
 * registered, and holds registration until the session has ended, so a token
 * refresh during the sign-out cannot bind the phone again. Bounded, and never
 * a reason to refuse or delay a sign-out past its cap.
 */

/** "Sign out": the sign-out flow's own cap (sign-out-flow.ts). */
export const SIGN_OUT_UNBIND_TIMEOUT_MS = 6_000;
/** "Use password instead" / "Use a different account" / the disabled screen. */
export const FALLBACK_UNBIND_TIMEOUT_MS = 4_000;
/** Signed out from another device: the alert waits for it. */
export const REVOKED_UNBIND_TIMEOUT_MS = 3_000;

export type UnbindResult =
  /** This phone's row for the account was deleted. */
  | 'deleted'
  /** The delete answered, and the account had no row for this token (already
   *  rebound to someone else, or never written). Not an error. */
  | 'none'
  /** This phone never registered a token: nothing to delete. */
  | 'nothing-registered'
  /** The delete did not answer within the budget; its request was aborted. */
  | 'timed-out'
  /** The delete was refused, the request failed, or the token could not be read. */
  | 'failed';

/**
 * Delete this phone's push token row for the signed-in account. Never throws.
 *
 * A registration already sent writes the row this deletes, so it is waited
 * for first, for at most half the budget, and the token is read after it. The
 * delete is by the token alone: row level security (push_tokens_self,
 * `user_id = auth.uid()`) keeps it to the caller's own row. It is awaited,
 * never voided (a supabase-js builder sends nothing until it is awaited,
 * pattern #22), and aborted when the budget runs out.
 */
export async function unbindThisDevice(opts: { timeoutMs: number }): Promise<UnbindResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let remembered: string | null;
  try {
    await registrationSettled(Math.floor(opts.timeoutMs / 2));
    remembered = await rememberedPushToken();
  } catch (e) {
    console.warn('[push] could not read the token this phone registered', e);
    return 'failed';
  }
  if (!remembered) return 'nothing-registered';
  const token = remembered;

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<UnbindResult>((resolve) => {
    timer = setTimeout(
      () => {
        ctrl.abort();
        resolve('timed-out');
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  // Settles whatever the delete does, so an answer after the budget is
  // dropped rather than left rejected.
  const removed = (async (): Promise<UnbindResult> => {
    try {
      const { data, error } = await supabase
        .from('push_tokens')
        .delete()
        .eq('token', token)
        .select('id')
        .abortSignal(ctrl.signal);
      if (error) {
        console.warn('[push] this phone’s token row was not deleted', error);
        return 'failed';
      }
      return Array.isArray(data) && data.length > 0 ? 'deleted' : 'none';
    } catch (e) {
      console.warn('[push] this phone’s token row was not deleted', e);
      return 'failed';
    }
  })();
  try {
    const result = await Promise.race([removed, timedOut]);
    if (result === 'timed-out') console.warn('[push] deleting this phone’s token row timed out');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export interface DeviceSignOutSteps {
  /** While the session still exists: hold registration, then delete this
   *  phone's row and send the note (if any) side by side. Never rejects. */
  beforeSessionEnds(): Promise<void>;
  /** Right after the session's end was decided: release the hold, and
   *  register again when the session survived. */
  afterSessionEnd(ended: boolean): Promise<void>;
  /** The backstop for a `finally`: release a hold the flow left. Safe to call
   *  more than once. */
  release(): void;
}

/**
 * This phone's own steps around a sign-out (sign-out-flow.ts
 * beforeSessionEnds/afterSessionEnd, auth-context.tsx signOutToFallback,
 * use-session-revocation.ts).
 */
export function deviceSignOutSteps(opts: {
  /** The signed-in user, to register again if the session survives. */
  user: User | null;
  unbindTimeoutMs: number;
  /** The sign-out note to the server (auth-notes.ts), sent beside the unbind. */
  note?: () => Promise<void>;
}): DeviceSignOutSteps {
  let held: symbol | null = null;
  const release = () => {
    if (held) releaseRegistration(held);
    held = null;
  };
  return {
    beforeSessionEnds: async () => {
      if (!held) held = holdRegistration();
      const note = opts.note;
      await Promise.all([
        unbindThisDevice({ timeoutMs: opts.unbindTimeoutMs }),
        note
          ? Promise.resolve()
              .then(note)
              .catch((e: unknown) => console.warn('[auth] the sign-out note failed', e))
          : undefined,
      ]);
    },
    afterSessionEnd: async (ended) => {
      release();
      if (!ended) await registerThisDevice(opts.user);
    },
    release,
  };
}

/**
 * Clear what Notification Center still shows of the account once this phone
 * is signed out (a deliberate sign-out, or one from another device): the
 * banners delivered before the unbind name its orders and purchase orders.
 * Never rejects.
 *
 * The one place the app calls dismissAllNotificationsAsync (pinned by
 * push-unbind.test.ts): #371's notificationIntents.clear replaces this body.
 */
export async function clearDeliveredNotifications(): Promise<void> {
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch (e) {
    console.warn('[push] could not clear delivered notifications', e);
  }
}
