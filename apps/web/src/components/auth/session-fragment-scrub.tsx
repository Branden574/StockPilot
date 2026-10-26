'use client';

import * as React from 'react';

import { fragmentWithoutSession } from '@/lib/auth/auth-page-notices';

/**
 * Takes a session that arrived in the URL fragment out of the address bar, on
 * whatever page it arrived. The root layout (app/layout.tsx) mounts it once, for
 * every page, and no page mounts it on its own
 * (app/layout.session-fragment-scrub.guard.test.ts).
 *
 * A link Supabase verified itself (its action_link: an older email, or one
 * sent from the Supabase dashboard) hands its session back in the fragment of
 * its redirect, and every redirect after that keeps the fragment. So it lands
 * wherever the link's redirect leads: /signin?error=auth_callback_failed for a
 * password reset (/auth/callback finds no code), /dashboard for the platform
 * console's owner invite or for any link a signed-in browser follows to
 * /signin (the proxy sends it on), /signin?redirect=%2Fdashboard for a
 * signed-out browser sent to /dashboard, and the landing page for a link with
 * no redirect (the project's Site URL). The app never uses that session
 * (lib/auth/auth-page-notices.ts, linkFragment: the browser client is
 * PKCE-only, and adopting it would be a login CSRF path), so the link is spent,
 * and on /signin the form says so. What is left is a live access token and
 * refresh token in the address bar and in the history entry, where a synced
 * history or a shared computer would hand them on. This swaps the fragment for
 * one that holds no token and still reads as a failed link; a fragment without
 * a session (an anchor, the label print view's parameters, GoTrue's own error)
 * is left alone. (Analytics never records a fragment:
 * components/analytics/posthog-provider.tsx turns that off, and its before_send
 * hook takes tokens out of every URL.)
 *
 * It replaces RecoveryFragmentGuard, which waited for the browser client to
 * adopt a recovery session and forwarded to /reset/complete. Under the PKCE
 * client that never happened: the guard polled for five seconds and gave up,
 * and the person stayed on a plain sign-in form with the tokens in the URL.
 *
 * ONE TICK LATER, WITH A NULL STATE. Next's App Router patches
 * history.replaceState in its own mount effect, which runs after this child's
 * (the router renders the root layout as its descendant), and the patched call
 * moves the router's own URL too, but only when the state
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
