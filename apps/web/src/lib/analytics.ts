/**
 * PostHog analytics wrapper — the single guard surface.
 *
 * Every export early-returns when `NEXT_PUBLIC_POSTHOG_KEY` is unset, so the
 * app ships dark: no `posthog.init()`, no network calls, no errors. Set the
 * key and the same code lights up without a deploy.
 *
 * posthog-js (~200KB) is LAZY-LOADED via dynamic import (P15): when the key is
 * unset the import is never triggered (the lib stays out of the bundle
 * entirely), and when set it loads as a separate chunk on first use instead of
 * weighing down the initial bundle for every route. The dynamic import resolves
 * to the SAME singleton PostHogProvider initializes, and posthog-js queues
 * events fired before `init()`, so ordering is safe.
 *
 * Client-only: posthog-js touches `window`, so callers must be in `'use client'`
 * components / effects.
 */
import { env } from '@/lib/env.client';

/** True only when the owner has configured a PostHog key. */
export const analyticsEnabled = Boolean(env.NEXT_PUBLIC_POSTHOG_KEY);

/** Lazy, memoized posthog-js loader — keeps the ~200KB lib out of the initial
 *  bundle. ESM dynamic imports are singletons, so this is the same instance
 *  PostHogProvider initializes. */
let posthogPromise: Promise<typeof import('posthog-js').default> | null = null;
function loadPosthog(): Promise<typeof import('posthog-js').default> {
  if (!posthogPromise) posthogPromise = import('posthog-js').then((m) => m.default);
  return posthogPromise;
}

/** Capture a product event. No-op when analytics is unconfigured. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled) return;
  // Fire-and-forget: lazy-load then capture. Analytics must never break a flow.
  void loadPosthog()
    .then((posthog) => posthog.capture(event, properties))
    .catch(() => {});
}

/** Associate subsequent events with a user. No-op when unconfigured. */
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled || !userId) return;
  void loadPosthog()
    .then((posthog) => posthog.identify(userId, properties))
    .catch(() => {});
}

/** Clear the identified user (call on sign-out). No-op when unconfigured. */
export function reset(): void {
  if (!analyticsEnabled) return;
  void loadPosthog()
    .then((posthog) => posthog.reset())
    .catch(() => {});
}
