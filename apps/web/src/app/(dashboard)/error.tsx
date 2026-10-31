'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
// The isomorphic reporter: this module is in a browser bundle, and
// @/lib/error-reporter is server-only (see error-reporter-core.ts).
import { reportError } from '@/lib/error-reporter-core';
import { SESSION_ENDED_PATH } from '@/lib/auth/session-ended';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';

/**
 * RSC error boundary for the dashboard route group. Without this, a server
 * component throwing during render shows up as a blank black screen with
 * no recovery path — Next.js' default error UI doesn't apply inside the
 * dashboard shell. Surfacing the error gives the user a clear retry +
 * sign-out path.
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
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    void reportError(error, {
      tag: 'dashboard.render',
      level: 'error',
      extra: { digest: error.digest ?? null },
    });
  }, [error]);

  return (
    <div className="flex justify-center px-4 py-16 sm:px-8 sm:py-24">
      <div className="border-border bg-card w-full max-w-md rounded-lg border p-6">
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
              The page hit an error mid-render. Try again, and if it keeps
              happening, sign out and back in.
            </p>
            {error.digest && (
              <p className="text-muted-foreground mt-2 font-mono text-[11.5px]">
                Error id: {error.digest}
              </p>
            )}
            {error.message && (
              <p className="text-muted-foreground bg-sunk border-border mt-2 break-words rounded-md border p-2 font-mono text-[11.5px]">
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={reset}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Go to overview</Link>
          </Button>
          {/* A button, not a link: nothing here can sign out from another tab (see above). */}
          <Button type="button" variant="ghost" onClick={signOutAndBackIn}>
            Sign out and back in
          </Button>
        </div>
      </div>
    </div>
  );
}
