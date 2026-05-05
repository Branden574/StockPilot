'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporter';

/**
 * RSC error boundary for the dashboard route group. Without this, a server
 * component throwing during render shows up as a blank black screen with
 * no recovery path — Next.js' default error UI doesn't apply inside the
 * dashboard shell. Surfacing the error gives the user a clear retry +
 * sign-out path.
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
    <div className="bg-background flex min-h-[100dvh] items-center justify-center px-4 py-10">
      <div className="border-border bg-card w-full max-w-md rounded-xl border p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-destructive mt-0.5 h-5 w-5" />
          <div className="flex-1">
            <h1 className="text-lg font-semibold">Something broke loading this page</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              The page hit an error mid-render. Try again, and if it keeps
              happening, sign out and back in.
            </p>
            {error.digest && (
              <p className="text-muted-foreground mt-2 font-mono text-[11px]">
                Error id: {error.digest}
              </p>
            )}
            {error.message && (
              <p className="text-muted-foreground bg-muted/50 mt-2 break-words rounded-md p-2 font-mono text-[11px]">
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={reset} variant="gradient">
            <RefreshCw className="h-4 w-4" /> Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Go to overview</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/signin">Sign out and back in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
