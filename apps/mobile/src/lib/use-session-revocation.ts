import * as React from 'react';
import { Alert } from 'react-native';

import {
  clearDeliveredNotifications,
  deviceSignOutSteps,
  REVOKED_UNBIND_TIMEOUT_MS,
} from './push-unbind';
import { checkThisSession } from './session-check';
import { supabase } from './supabase';

/**
 * Force-logout listener: when the server broadcasts that THIS device's session
 * was revoked from another device, sign out locally. Mirrors the web
 * SessionRevocationListener. Fail-silent (the refresh-token revocation still
 * logs the device out within the access-token TTL).
 *
 * A MESSAGE IS A CLAIM, NOT A FACT (S5, integrator decision 2026-11-02). The
 * channel is public: anyone holding the app's public key and the person's user
 * id can send `{ keepId: 'x' }` to it, and the phone used to sign out on that
 * alone. Every real sender ends the session before it sends, so the phone now
 * asks the Auth server about its own session first (session-check.ts), and
 * only an answer that the session is gone lets anything below happen. A
 * session the server still accepts means the message is forged or stale, and
 * no answer proves nothing: in both cases nothing happens at all, as on the
 * web. The question goes out on its own, never through auth-js's getUser(),
 * which would remove the session from the device and leave the push token
 * delete below with no token to send.
 *
 * Channel: `user:{userId}:sessions`  Event: `revoked`
 * Payload variants:
 *   { sessionIds: string[] }  — sign out iff own session id ∈ sessionIds
 *   { keepId: string }        — sign out iff own session id ≠ keepId
 *   { …, reason: 'account_disabled' } — OPTIONAL, additive. Names WHAT the
 *     revocation was. Only a platform disable sends it today; every payload
 *     without it behaves exactly as it always has.
 *
 * `onTargeted` is an optional first refusal, run BEFORE the local sign-out
 * while the access token GoTrue needs to answer still exists. It returns true
 * when it has fully handled the eviction itself, which suppresses the default
 * sign-out, the alert and `onSignedOut`. RootGate passes the account gate's
 * handler, and the RAW PAYLOAD is forwarded to it: a platform disable revokes
 * sessions through this same broadcast, after which the device's own auth probe
 * can only ever answer `session_not_found` — so the reason on the payload is
 * the one signal that survives the revocation, and "You were signed out from
 * another device." is simply not what happened.
 *
 * This listener stays deliberately dumb about that reason. It forwards it and
 * nothing more: whether the session ended is settled above, but whether it
 * ended because the account was DISABLED is a further claim, and that
 * judgement lives with the account gate.
 *
 * THIS PHONE'S PUSH TOKEN (S5, open question 5). A phone signed out from
 * another device kept its push_tokens row, so it kept showing the account's
 * notifications. Once the Auth server has said the session is gone, while the
 * access token the delete needs is still on the device, push registration is
 * held and this phone's row is deleted (push-unbind.ts, at most 3 s). It runs
 * BEFORE the account gate's probe, never beside it: the probe's getUser()
 * holds auth-js's lock and, for a session the server has ended, removes the
 * session from the device (auth-js 2.105.1 GoTrueClient.js:2472, 2508-2511),
 * and a delete queued behind it reads its token through getSession() under
 * that same lock (supabase-js index.cjs:520-525) and goes out with no session,
 * as the anon key, which deletes nothing. Once signed out, Notification Center
 * is cleared of what the account still showed there.
 */
export function useSessionRevocation(
  userId: string | null,
  onSignedOut: () => void,
  options: { onTargeted?: (payload: unknown) => Promise<boolean> } = {},
): void {
  // Held in a ref, not a dependency: `options` is a fresh object every render,
  // so depending on it would tear down and re-subscribe the channel on every
  // parent re-render.
  const onTargetedRef = React.useRef(options.onTargeted);
  React.useEffect(() => {
    onTargetedRef.current = options.onTargeted;
  }, [options.onTargeted]);

  React.useEffect(() => {
    if (!userId) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let mySessionId: string | null = null;

    async function start() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        try {
          const seg = token.split('.')[1] ?? '';
          // base64url -> JSON (RN-safe: no Node Buffer)
          const json = decodeURIComponent(
            atob(seg.replace(/-/g, '+').replace(/_/g, '/'))
              .split('')
              .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join(''),
          );
          mySessionId = (JSON.parse(json) as { session_id?: string }).session_id ?? null;
        } catch {
          mySessionId = null;
        }
      }
      if (cancelled) return;
      channel = supabase.channel(`user:${userId}:sessions`);
      channel.on('broadcast', { event: 'revoked' }, ({ payload }) => {
        const p = (payload ?? {}) as { sessionIds?: string[]; keepId?: string | null };
        const targeted =
          (Array.isArray(p.sessionIds) && !!mySessionId && p.sessionIds.includes(mySessionId)) ||
          ('keepId' in p && !!mySessionId && p.keepId !== mySessionId);
        if (!targeted) return;
        void (async () => {
          // The claim, checked before anything else: only an answer that this
          // session is gone goes on. A live session or no answer: nothing
          // happens, not even the hold (see above).
          if ((await checkThisSession()) !== 'gone') return;
          const deviceSteps = deviceSignOutSteps({
            user: null,
            unbindTimeoutMs: REVOKED_UNBIND_TIMEOUT_MS,
          });
          try {
            // This phone's push token row, while the token the delete needs
            // is still here, and before the gate's probe (see above).
            try {
              await deviceSteps.beforeSessionEnds();
            } catch {
              /* best effort: the sign-out goes on */
            }
            // First refusal, while the token is still on the device: if this
            // revoke is really a platform disable, the account gate takes over
            // and shows the disabled screen instead of the wrong sentence. The
            // whole payload goes across — the gate needs the `reason` field, and
            // narrowing it here would put the decision in the wrong module.
            if (onTargetedRef.current) {
              try {
                if (await onTargetedRef.current(payload)) return;
              } catch {
                /* fall through to the ordinary force-logout */
              }
            }
            // scope:'local' clears ONLY this device. The authoritative server-side
            // revoke already happened (the broadcaster deleted our auth.sessions
            // row); a default global signOut here would cascade and revoke the
            // user's OTHER devices too — defeating "sign out just this one".
            try {
              await supabase.auth.signOut({ scope: 'local' });
            } catch {
              /* the refresh token is already dead server-side either way */
            }
            await clearDeliveredNotifications();
          } finally {
            deviceSteps.release();
          }
          Alert.alert(
            'Signed out',
            'You were signed out from another device.',
            [{ text: 'OK' }],
            { cancelable: false },
          );
          onSignedOut();
        })();
      });
      channel.subscribe();
    }
    void start();

    return () => {
      cancelled = true;
      if (channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
    };
  }, [userId, onSignedOut]);
}
