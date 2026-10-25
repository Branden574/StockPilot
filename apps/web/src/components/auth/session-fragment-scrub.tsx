'use client';

import * as React from 'react';

import { fragmentWithoutSession } from '@/lib/auth/auth-page-notices';

/**
 * Takes a session that arrived in the URL fragment out of the address bar of
 * /signin.
 *
 * A link Supabase verified itself (its action_link: an older email, or one
 * sent from the Supabase dashboard) hands its session back in the fragment, and
 * /auth/callback or the proxy keeps that fragment on the way here. The app
 * never uses that session (lib/auth/auth-page-notices.ts, linkFragment: the
 * browser client is PKCE-only, and adopting it would be a login CSRF path), so
 * the link is spent and the sign-in form says so. What is left is a live access
 * token and refresh token in the address bar and in the history entry, where a
 * synced history or a shared computer would hand them on. This swaps the
 * fragment for one that holds no token and still reads as a failed link.
 *
 * It replaces RecoveryFragmentGuard, which waited for the browser client to
 * adopt a recovery session and forwarded to /reset/complete. Under the PKCE
 * client that never happened: the guard polled for five seconds and gave up,
 * and the person stayed on a plain sign-in form with the tokens in the URL.
 *
 * ONE TICK LATER, WITH A NULL STATE. Next's App Router patches
 * history.replaceState in its own mount effect, which runs after this child's,
 * and the patched call moves the router's own URL too, but only when the state
 * passed in is not the router's (history.state carries its `__NA` marker). Left
 * behind, the router would write its old URL, tokens included, back into the
 * address bar on its next state change (a server action's refresh, say).
 */
export function SessionFragmentScrub() {
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const replacement = fragmentWithoutSession(window.location.hash);
      if (replacement === null) return;
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', `${pathname}${search}${replacement}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
