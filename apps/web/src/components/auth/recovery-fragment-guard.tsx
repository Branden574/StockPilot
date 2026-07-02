'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createClient } from '@/lib/supabase/client';

/**
 * Rescues LEGACY password-recovery links that land on /signin.
 *
 * Emails sent before 81a78c35 (and any reset triggered from the Supabase
 * dashboard) carry Supabase's raw action_link: /auth/v1/verify redirects
 * to our server callback with the session in the URL FRAGMENT. The server
 * can't see fragments, so /auth/callback bounces to /signin — where the
 * browser Supabase client's detectSessionInUrl silently ADOPTS the
 * recovery session from the fragment. Net effect the owner reported:
 * "clicked the email and it just signed me back in" — logged in on the
 * overview, never shown the set-password form.
 *
 * This guard runs only on /signin: if the URL fragment says a recovery
 * session just arrived, wait for the client to store it, then forward to
 * /reset/complete so the user actually gets to set a new password.
 */
export function RecoveryFragmentGuard() {
  const router = useRouter();

  React.useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes('type=recovery') || !hash.includes('access_token')) return;

    let cancelled = false;
    const supabase = createClient();
    // detectSessionInUrl processes the fragment asynchronously on client
    // creation; poll briefly until the session is stored, then redirect.
    const started = Date.now();
    const tick = async () => {
      if (cancelled) return;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        router.replace('/reset/complete');
        return;
      }
      if (Date.now() - started < 5000) {
        setTimeout(tick, 150);
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
