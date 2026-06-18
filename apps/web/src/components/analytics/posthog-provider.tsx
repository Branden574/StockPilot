'use client';

import posthog from 'posthog-js';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { env } from '@/lib/env';

/**
 * PostHog bootstrap. Mounted at the app root so pageviews + autocapture
 * cover every route.
 *
 * INERT BY DEFAULT: when `NEXT_PUBLIC_POSTHOG_KEY` is empty we never call
 * `posthog.init()`, so there is no network traffic and no errors. The owner
 * can light analytics up later just by setting the env var — no code change.
 *
 * Init runs in `useEffect` (never during SSR) and is guarded against the
 * double-invoke React StrictMode does in development via `posthog.__loaded`.
 */
export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return; // unconfigured → do nothing (no init, no network)
    if (posthog.__loaded) return; // already initialized (StrictMode re-mount)

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
  }, []);

  return <>{children}</>;
}
