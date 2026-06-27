import * as React from 'react';
import { Alert } from 'react-native';

import { supabase } from './supabase';

/**
 * Force-logout listener: when the server broadcasts that THIS device's session
 * was revoked from another device, sign out locally. Mirrors the web
 * SessionRevocationListener. Fail-silent (the refresh-token revocation still
 * logs the device out within the access-token TTL).
 *
 * Channel: `user:{userId}:sessions`  Event: `revoked`
 * Payload variants:
 *   { sessionIds: string[] }  — sign out iff own session id ∈ sessionIds
 *   { keepId: string }        — sign out iff own session id ≠ keepId
 */
export function useSessionRevocation(userId: string | null, onSignedOut: () => void): void {
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
        // scope:'local' clears ONLY this device. The authoritative server-side
        // revoke already happened (the broadcaster deleted our auth.sessions
        // row); a default global signOut here would cascade and revoke the
        // user's OTHER devices too — defeating "sign out just this one".
        void supabase.auth.signOut({ scope: 'local' }).finally(() => {
          Alert.alert(
            'Signed out',
            'You were signed out from another device.',
            [{ text: 'OK' }],
            { cancelable: false },
          );
          onSignedOut();
        });
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
