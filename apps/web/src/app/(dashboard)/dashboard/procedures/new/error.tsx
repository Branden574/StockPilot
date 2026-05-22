'use client';

import * as React from 'react';

/**
 * Surfaces the actual error message for the procedures Create flow
 * instead of falling back to Next.js's generic "specific message
 * omitted in production" overlay. Temporary — once the digest-only
 * 500 we've been chasing is identified and fixed, this file can be
 * removed (the parent (dashboard) error boundary handles everything
 * else just fine).
 */
export default function ProceduresNewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[procedures/new error.tsx]', error);
  }, [error]);

  return (
    <div className="container mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Procedure failed to load
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We hit an error while opening the new-procedure form or saving
        your changes.
      </p>
      <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 text-[11px] leading-relaxed text-foreground">
        {error.message || 'Unknown error'}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="bg-foreground text-background hover:opacity-90 mt-4 inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium"
      >
        Try again
      </button>
    </div>
  );
}
