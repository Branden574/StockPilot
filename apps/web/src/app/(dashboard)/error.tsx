'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { AppearanceRecovery } from '@/components/theme/appearance-recovery';
import { Button } from '@/components/ui/button';
// The isomorphic reporter: this module is in a browser bundle, and
// @/lib/error-reporter is server-only (see error-reporter-core.ts).
import { reportError } from '@/lib/error-reporter-core';
import { knownErrorState } from '@/lib/known-error-states';
import { SESSION_ENDED_PATH } from '@/lib/auth/session-ended';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';

/**
 * RSC error boundary for the dashboard route group. Without this, a server
 * component throwing during render shows up as a blank black screen with
 * no recovery path — Next.js' default error UI doesn't apply inside the
 * dashboard shell. Surfacing the error gives the user a clear retry +
 * sign-out path.
 *
 * "Try again" asks the server for the page again: it calls the boundary's
 * `retry`, which re-fetches and re-renders the page (a failed server read can
 * then succeed), and falls back to `reset` only when no `retry` is given.
 *
 * WHAT IT PRINTS. A Server Component's error reaches this file, in a
 * production build, as React's stand-in: its `message` is React's own
 * minified text with a link to its error list, never the page's. So the
 * message is printed only outside a production build (for the developer);
 * the error id (the digest) is always printed, for support.
 *
 * A STATE THE APP KNOWS. A digest the app set itself names a state
 * (lib/known-error-states). A page that could not check the member's access
 * is not a crash: the card says so in plain words with Try again, and leaves
 * out the crash card's advice (sign out and back in), its error id and its
 * other actions. It is reported as a warning, not as an error.
 *
 * "Sign out and back in" really signs out: it is a full page load of the
 * cookie-clearing route (app/auth/session-ended), which ends this device's
 * session and lands on sign-in. It used to link to /signin, which the proxy
 * sends a signed-in visitor straight back from, so nothing happened.
 *
 * Its click first removes what an interrupted run kept in this tab
 * (lib/interrupted-run): this is a sign-out on purpose. The route itself
 * cannot (sessionStorage is the browser's), and it must not: the dashboard's
 * own redirect there, for a session that expired, keeps the record so the
 * person gets back to their work. The same call tells the browser's other
 * tabs, which the route signs out too (the session cookies are the
 * browser's) without telling them.
 *
 * So it is a button, never a link to the route. A link can be opened in
 * another tab (a middle-click, the context menu, a long press), which signs
 * the whole browser out while no tab runs the purge and every tab keeps its
 * records. A Next <Link> would also prefetch the route, and prefetching it
 * would sign the person out just for seeing this card.
 */
function signOutAndBackIn(): void {
  purgeInterruptedRuns();
  window.location.assign(SESSION_ENDED_PATH);
}

export default function DashboardError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  /** Asks the server for the page again and renders what comes back. */
  retry?: () => void;
  /** Clears the error and renders the same answer again, with no new read. */
  reset?: () => void;
}) {
  const known = knownErrorState(error);
  const knownKey = known?.key ?? null;
  React.useEffect(() => {
    void reportError(error, {
      tag: 'dashboard.render',
      level: knownKey ? 'warning' : 'error',
      extra: { digest: error.digest ?? null },
    });
  }, [error, knownKey]);

  const tryAgain = () => (retry ?? reset)?.();
  // Never in a production build: there it is React's stand-in text, or
  // whatever a browser-side error carried.
  const showMessage = process.env.NODE_ENV !== 'production' && Boolean(error.message);

  if (known) {
    return (
      <div className="flex justify-center px-4 py-16 sm:px-8 sm:py-24" data-glass="error-frame">
        <div
          className="border-border bg-card w-full max-w-md rounded-lg border p-6"
          data-glass-role="error-card"
          data-error-state={known.key}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="text-warning mt-0.5 size-5 shrink-0"
              strokeWidth={1.8}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[20px] font-medium leading-tight tracking-[-0.02em]">
                {known.title}
              </h1>
              <p className="text-muted-foreground mt-1.5 text-[13.5px] leading-relaxed">
                {known.body}
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={tryAgain}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // data-glass and data-glass-role: inert hooks for Liquid Glass
    // (styles/liquid-glass/states.css: the error card in the pane).
    <div className="flex justify-center px-4 py-16 sm:px-8 sm:py-24" data-glass="error-frame">
      <div
        className="border-border bg-card w-full max-w-md rounded-lg border p-6"
        data-glass-role="error-card"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="text-destructive mt-0.5 size-5 shrink-0"
            strokeWidth={1.8}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[20px] font-medium leading-tight tracking-[-0.02em]">
              Something broke loading this page
            </h1>
            <p className="text-muted-foreground mt-1.5 text-[13.5px] leading-relaxed">
              The page hit an error mid-render. Try again, and if it keeps happening, sign out and
              back in.
            </p>
            {error.digest && (
              <p
                className="text-muted-foreground mt-2 font-mono text-[11.5px]"
                data-glass-role="error-digest"
              >
                Error id: {error.digest}
              </p>
            )}
            {showMessage && (
              <p
                className="text-muted-foreground bg-sunk border-border mt-2 break-words rounded-md border p-2 font-mono text-[11.5px]"
                data-glass-role="error-message"
              >
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {/* `retry` re-fetches the page from the server (Next's error file
              convention); `reset` alone would render the same failed answer
              again. `reset` is the fallback, as on the settings error card. */}
          <Button onClick={tryAgain}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Go to overview</Link>
          </Button>
          {/* A button, not a link: nothing here can sign out from another tab (see above). */}
          <Button type="button" variant="ghost" onClick={signOutAndBackIn}>
            Sign out and back in
          </Button>
          {/* "Use classic design", only while Liquid Glass is shown; nothing in classic. */}
          <AppearanceRecovery error={error} />
        </div>
      </div>
    </div>
  );
}
