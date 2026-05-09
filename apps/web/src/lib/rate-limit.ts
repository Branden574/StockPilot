import 'server-only';

/**
 * Tiny in-memory rate limit helper. Per-process — meaning each Vercel
 * serverless instance keeps its own counter. That's fine for v1: we want
 * cheap protection against accidental spamming and trivial scripted
 * abuse on the public order-request form, not enterprise-grade DoS
 * defense. Real attackers will hit cold instances and effectively get
 * the per-window limit per region; that's still orders of magnitude
 * below Resend's per-day caps so the email pipeline stays safe.
 *
 * v1.1 follow-up: move to a Supabase-backed `rate_limit_buckets` table
 * with atomic upsert (org_id, key, count, window_started_at) so the
 * counter survives cold starts and is shared across regions.
 */

interface Bucket {
  /** Number of requests counted in the current window. */
  count: number;
  /** Epoch ms when the current window expires and resets. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; resetAt: number } {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }

  if (existing.count >= limit) {
    return { allowed: false, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return { allowed: true, resetAt: existing.resetAt };
}

/**
 * Test-only helper — clears the in-memory map. NEVER call this from
 * application code; rate-limit reset must come from the window expiring
 * naturally, not from a privileged caller.
 */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
