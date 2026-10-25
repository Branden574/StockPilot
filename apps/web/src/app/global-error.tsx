'use client';

import * as React from 'react';
import { listenForPurges, purgeInterruptedRuns } from '@/lib/interrupted-run';
import { isSharePath } from '@/lib/share-paths';

/** lib/auth/session-ended.ts SESSION_ENDED_PATH, written out (no import, see below). */
const SIGN_OUT_PATH = '/auth/session-ended';

/**
 * Last-resort error boundary. Triggers when even the root layout itself
 * fails to render — in that case Next.js can't reuse <html>/<body> from
 * layout.tsx, so this file owns the whole document. Without it, root
 * layout errors render as a blank/black screen, which is what Andrew
 * was hitting in Chrome on certain sections (Brave masked it because
 * cached client JS recovered, Chrome did not).
 *
 * Pure inline styles only — Tailwind / global CSS may not have loaded
 * yet when this renders. The colours are the redesign's dark palette as
 * plain hex (page #0c0d0a, ink #f0efe8, ink-3 #9a9b91, hairlines #1f201b /
 * #2a2b25, danger #e87a5e): the theme tokens may not exist here either.
 *
 * "Sign out and back in" loads the cookie-clearing sign-out route
 * (app/auth/session-ended) in this tab, which ends this device's session and
 * lands on sign-in. It used to point at /signin, which the proxy bounces a
 * signed-in visitor straight back from, so nothing happened. Its click first
 * removes what an interrupted run kept in this tab (lib/interrupted-run): this
 * is a sign-out on purpose, and the route cannot reach sessionStorage. The
 * same call tells the browser's other tabs, which the route signs out too
 * (the session cookies are the browser's) without telling them. So it is a
 * button, never a link to the route: a link can be opened in another tab (a
 * middle-click, the context menu, a long press), which signs the whole
 * browser out while no tab runs the purge and every tab keeps its records.
 *
 * The page replaces the root layout, whose InterruptedRunExpiry listens for a
 * sign-out in another tab on every other page, so it listens itself while it
 * shows.
 *
 * This file must not depend on anything that broke, so besides React it
 * imports only modules that import nothing themselves (share-paths and
 * interrupted-run; global-error.sign-out.test.tsx checks it). That is why the
 * route's path is written out above: lib/auth/session-ended.ts imports
 * next/navigation.
 */
function signOutAndBackIn(): void {
  purgeInterruptedRuns();
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full page load: the sign-out route is a route handler, not a page, and this page cannot rely on the router.
  window.location.assign(SIGN_OUT_PATH);
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A sign-out in another tab of this browser clears this tab too (see above).
  React.useEffect(() => listenForPurges(), []);

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
          background: '#0c0d0a',
          color: '#f0efe8',
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: '#e87a5e',
              marginBottom: 12,
            }}
          >
            Something went wrong
          </div>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 500,
              letterSpacing: '-0.025em',
              margin: 0,
              lineHeight: 1.25,
            }}
          >
            We hit a problem loading the page
          </h1>
          <p
            style={{
              marginTop: 12,
              color: '#9a9b91',
              fontSize: 13.5,
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
                color: '#9a9b91',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11.5,
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
                background: '#f0efe8',
                color: '#0c0d0a',
                border: '1px solid #f0efe8',
                borderRadius: 6,
                padding: '7px 14px',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/dashboard"
              style={{
                background: '#131410',
                color: '#f0efe8',
                border: '1px solid #2a2b25',
                borderRadius: 6,
                padding: '7px 12px',
                fontSize: 13,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Go to dashboard
            </a>
            <button
              type="button"
              onClick={signOutAndBackIn}
              style={{
                background: 'transparent',
                color: '#d8d6cc',
                border: '1px solid #1f201b',
                borderRadius: 6,
                padding: '7px 12px',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Sign out and back in
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
