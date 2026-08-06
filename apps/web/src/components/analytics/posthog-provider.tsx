'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { env } from '@/lib/env.client';
import { isSharePath } from '@/lib/share-paths';

/**
 * PostHog bootstrap. Mounted at the app root so pageviews + autocapture
 * cover every route — EXCEPT the public share surfaces under `/m/` and
 * `/r/` (fix wave I6). Those URLs carry a raw, unauthenticated credential
 * IN THE PATH ITSELF, and PostHog's pageview/autocapture ships
 * `window.location.href` verbatim to a third-party vendor — that would
 * leak the token (GC 27: never log a share token or signed URL).
 * `NEXT_PUBLIC_POSTHOG_KEY` is unset in both env files as of this fix wave,
 * so none of this fires today — but it is exactly one env var away from
 * going live, with no code change that would catch it at that point, so
 * the guard is on the PATH, not on the key staying empty forever.
 *
 * INERT BY DEFAULT: when `NEXT_PUBLIC_POSTHOG_KEY` is empty we never import or
 * init posthog-js, so there is no network traffic, no errors, and the ~200KB
 * lib never enters any bundle. The owner can light analytics up later just by
 * setting the env var — no code change.
 *
 * posthog-js is LAZY-LOADED via dynamic import (P15) so it stays out of the
 * root bundle that wraps every route. Init runs in `useEffect` (never during
 * SSR) and is guarded against the StrictMode double-invoke via `__loaded`.
 */
export function PostHogProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onSharePath = isSharePath(pathname);

  useEffect(() => {
    const key = env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return; // unconfigured → do nothing (no import, no init, no network)
    if (onSharePath) {
      // Never initialize FROM a share path. `capture_pageview`/`autocapture`
      // are init-time-only options, so if the singleton is somehow already
      // loaded (an in-app client-side transition landed here from a normal
      // page — unlikely, but not impossible), opt it out rather than let it
      // keep capturing while we're on a token-bearing URL.
      void import('posthog-js').then(({ default: posthog }) => {
        if (posthog.__loaded) posthog.opt_out_capturing();
      });
      return;
    }
    let cancelled = false;
    void import('posthog-js').then(({ default: posthog }) => {
      if (cancelled || posthog.__loaded) return; // unmounted or already initialized
      posthog.init(key, {
        // First-party reverse proxy (next.config rewrites /ingest → PostHog US
        // Cloud). Same-origin so the app's CSP connect-src 'self' allows it and
        // ad blockers / Brave can't drop it. MUST match the /ingest rewrite.
        api_host: '/ingest',
        // Where the PostHog APP lives (toolbar/links) — NOT the ingest path.
        ui_host: 'https://us.posthog.com',
        capture_pageview: true,
        autocapture: true,
        // Only allocate a person profile once we explicitly identify() a
        // signed-in user — anonymous visitors stay anonymous, which keeps the
        // billable person count tied to real users.
        person_profiles: 'identified_only',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [onSharePath]);

  return <>{children}</>;
}
