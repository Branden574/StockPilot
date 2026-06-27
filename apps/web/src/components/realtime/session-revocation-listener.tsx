'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';

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
      // session_id claim identifies our own auth.sessions row.
      const token = session?.access_token;
      if (token) {
        try {
          const payload = JSON.parse(
            Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
          ) as { session_id?: string };
          mySessionIdRef.current = payload.session_id ?? null;
        } catch {
          mySessionIdRef.current = null;
        }
      }
      if (cancelled) return;
      channel = supabase!.channel(`user:${userId}:sessions`);
      channel.on('broadcast', { event: 'revoked' }, ({ payload }) => {
        const p = (payload ?? {}) as { sessionIds?: string[]; keepId?: string | null };
        const mine = mySessionIdRef.current;
        const targeted =
          (Array.isArray(p.sessionIds) && !!mine && p.sessionIds.includes(mine)) ||
          ('keepId' in p && !!mine && p.keepId !== mine);
        if (!targeted) return;
        // scope:'local' clears ONLY this browser. The authoritative server-side
        // revoke already happened (the broadcaster deleted our auth.sessions
        // row); a default global signOut here would cascade and revoke the
        // user's OTHER devices too — defeating "sign out just this one".
        void supabase!.auth.signOut({ scope: 'local' }).finally(() => {
          toast.message('You were signed out from another device.');
          router.replace('/signin');
        });
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
