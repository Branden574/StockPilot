/**
 * PostHog analytics wrapper — the single guard surface.
 *
 * Every export early-returns when `NEXT_PUBLIC_POSTHOG_KEY` is unset, so the
 * app ships dark: no `posthog.init()`, no network calls, no errors. Set the
 * key and the same code lights up without a deploy.
 *
 * These helpers are safe to call before (or even without) `posthog.init()` —
 * posthog-js queues/no-ops internally, and the key guard means we never reach
 * it at all when analytics is off. Client-only: posthog-js touches `window`,
 * so callers must be in `'use client'` components / effects.
 */
import posthog from 'posthog-js';

import { env } from '@/lib/env';

/** True only when the owner has configured a PostHog key. */
export const analyticsEnabled = Boolean(env.NEXT_PUBLIC_POSTHOG_KEY);

/** Capture a product event. No-op when analytics is unconfigured. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Analytics must never break a user flow.
  }
}

/** Associate subsequent events with a user. No-op when unconfigured. */
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled || !userId) return;
  try {
    posthog.identify(userId, properties);
  } catch {
    // Analytics must never break a user flow.
  }
}

/** Clear the identified user (call on sign-out). No-op when unconfigured. */
export function reset(): void {
  if (!analyticsEnabled) return;
  try {
    posthog.reset();
  } catch {
    // Analytics must never break a user flow.
  }
}
