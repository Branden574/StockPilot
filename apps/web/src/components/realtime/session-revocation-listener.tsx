'use client';

import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { forgetTourState } from '@/lib/onboarding/tour-state-cache';
import { createClient } from '@/lib/supabase/client';

import { sessionIdFromAccessToken } from './session-id-from-token';

/**
 * Listens for a "you've been signed out" broadcast targeting THIS device and, if
 * matched, signs out + redirects to /signin live. Mirrors PermissionsRealtime.
 * Fail-silent: if the socket can't open, the refresh-token revocation + token
 * expiry still lock the device out within the hour.
 */
export function SessionRevocationListener({ userId }: { userId: string }) {
  const router = useRouter();
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      supabaseRef.current = null;
    }
  }
  const mySessionIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    async function start() {
      const {
        data: { session },
      } = await supabase!.auth.getSession();
      // session_id claim identifies our own auth.sessions row. Used ONLY to
      // match a broadcast to this tab, never to authorize anything.
      mySessionIdRef.current = sessionIdFromAccessToken(session?.access_token);
      if (cancelled) return;
      channel = supabase!.channel(`user:${userId}:sessions`);
      channel.on('broadcast', { event: 'revoked' }, ({ payload }) => {
        const p = (payload ?? {}) as { sessionIds?: string[]; keepId?: string | null };
        const mine = mySessionIdRef.current;
        const targeted =
          (Array.isArray(p.sessionIds) && !!mine && p.sessionIds.includes(mine)) ||
          ('keepId' in p && !!mine && p.keepId !== mine);
        if (!targeted) return;
        // THE CHANNEL IS PUBLIC, so a message is a claim, not a fact: anyone
        // holding the anon key and this user's id could send one, and signing
        // out on the claim alone would let them sign a user's web tabs out at
        // will. Every server path revokes BEFORE it broadcasts (sessions.ts),
        // so a real message means GoTrue no longer knows this session. Ask it:
        // a session it still accepts means the message is forged or stale, and
        // nothing happens; a request that could not be made proves nothing
        // either way, and token expiry still ends a revoked session. Only an
        // answer that the session is gone signs this tab out. (Mobile keeps the
        // same rule: use-session-revocation.ts.)
        void (async () => {
          const { error } = await supabase!.auth.getUser();
          if (!error) return;
          if (isAuthRetryableFetchError(error)) return;
          // Per-person state kept for the browser session goes with the session.
          forgetTourState();
          // scope:'local' clears ONLY this browser. The authoritative server-side
          // revoke already happened (the broadcaster deleted our auth.sessions
          // row); a default global signOut here would cascade and revoke the
          // user's OTHER devices too — defeating "sign out just this one".
          await supabase!.auth.signOut({ scope: 'local' }).catch(() => {});
          toast.message('You were signed out from another device.');
          router.replace('/signin');
        })();
      });
      channel.subscribe();
    }
    void start();

    return () => {
      cancelled = true;
      if (channel && supabase) {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
    };
  }, [userId, router]);

  return null;
}
