'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    // Crash beacon: surface production client crashes in the server-side
    // error feed (ERROR_WEBHOOK_URL). Fire-and-forget; failures are ignored.
    try {
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: error.message,
          digest: error.digest,
          path: window.location.pathname,
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
