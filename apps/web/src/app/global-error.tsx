'use client';

import * as React from 'react';
import { isSharePath } from '@/lib/share-paths';

/**
 * Last-resort error boundary. Triggers when even the root layout itself
 * fails to render — in that case Next.js can't reuse <html>/<body> from
 * layout.tsx, so this file owns the whole document. Without it, root
 * layout errors render as a blank/black screen, which is what Andrew
 * was hitting in Chrome on certain sections (Brave masked it because
 * cached client JS recovered, Chrome did not).
 *
 * Pure inline styles only — Tailwind / global CSS may not have loaded
 * yet when this renders.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Best-effort report; we don't bring in the error-reporter module
    // here because it might be the very thing that broke. A bare fetch to
    // the crash beacon is dependency-free and safe to attempt.
    try {
      console.error('[global-error]', error);
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: error?.message,
          digest: error?.digest,
          // Share pages carry the token in the pathname; never ship it to the
          // error webhook (GC 27). Mirrors the same guard in error.tsx.
          path: isSharePath(window.location.pathname) ? null : window.location.pathname,
          boundary: 'global-error',
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* noop */
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0b',
          color: '#fafafa',
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginBottom: 12,
            }}
          >
            Something went wrong
          </div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            We hit a problem loading the page
          </h1>
          <p
            style={{
              marginTop: 12,
              color: '#a1a1aa',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            Try again. If it keeps happening, fully refresh (Cmd/Ctrl+Shift+R)
            or sign out and back in. Your data is safe — this is a render
            error, not a data error.
          </p>
          {error?.digest && (
            <p
              style={{
                marginTop: 12,
                color: '#71717a',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
              }}
            >
              Error id: {error.digest}
            </p>
          )}
          <div
            style={{
              marginTop: 20,
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                background: '#fafafa',
                color: '#0a0a0b',
                border: '1px solid #fafafa',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/dashboard"
              style={{
                background: 'transparent',
                color: '#fafafa',
                border: '1px solid #3f3f46',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Go to dashboard
            </a>
            <a
              href="/signin"
              style={{
                background: 'transparent',
                color: '#a1a1aa',
                border: '1px solid #27272a',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Sign out and back in
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
