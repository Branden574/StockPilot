'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { isSharePath } from '@/lib/share-paths';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    // Crash beacon: surface production client crashes in the server-side
    // error feed (ERROR_WEBHOOK_URL). Fire-and-forget; failures are ignored.
    try {
      const pathname = window.location.pathname;
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: error.message,
          digest: error.digest,
          // GC 27 — never log a share token: /m/<token> and /r/<token>
          // carry the credential in the path itself, and this beacon's
          // `path` lands in the error-reporter feed (fix wave I6). A
          // signed-in staff member previewing their own org's share link
          // could otherwise leak a live token into that feed on a crash.
          path: isSharePath(pathname) ? null : pathname,
          boundary: 'error',
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* noop */
    }
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        We hit an unexpected error. Try again, or refresh the page. If it keeps happening, contact support.
      </p>
      <Button onClick={reset} variant="gradient">
        Try again
      </Button>
    </div>
  );
}
