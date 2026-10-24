'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
// The isomorphic reporter: this module is in a browser bundle, and
// @/lib/error-reporter is server-only (see error-reporter-core.ts).
import { reportError } from '@/lib/error-reporter-core';
import { SESSION_ENDED_PATH } from '@/lib/auth/session-ended';

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
 * sends a signed-in visitor straight back from, so nothing happened. A plain
 * <a>, never a Next <Link>: a Link would prefetch that route, and prefetching
 * it would sign the person out just for seeing this card.
 */
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
          <Button asChild variant="ghost">
            {/* A plain <a>: a full load of a route handler (see above). */}
            <a href={SESSION_ENDED_PATH}>Sign out and back in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
