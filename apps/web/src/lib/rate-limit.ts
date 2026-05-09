import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Persistent rate-limit helper backed by the Supabase
 * `rate_limit_buckets` table + the SECURITY DEFINER
 * `increment_rate_limit()` RPC (migration 0048). Replaces the previous
 * in-memory Map which:
 *   • didn't survive Vercel cold starts (every fresh instance got a
 *     clean counter — bypassable by hitting cold instances)
 *   • wasn't shared across Vercel regions
 *   • leaked memory unbounded over a warm instance's lifetime
 *
 * The RPC handles atomic check-and-increment with row locks, so two
 * simultaneous calls with the same key serialize correctly. Returns
 * `{ allowed, count, resetAt }` matching the previous shape.
 *
 * Uses the admin client so callers (including the public, unauth POST
 * endpoint) don't need RLS access. The RPC enforces no auth on its
 * own; the gate is "you can call it" which we accept on every code
 * path.
 *
 * Failure mode: if the RPC throws (DB unreachable, table missing
 * during a deploy gap), we fail OPEN — return allowed=true with a
 * placeholder reset. Failing closed would soft-DoS the public order
 * form during a transient DB blip; we'd rather log + allow than
 * stonewall legitimate users.
 */

interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetAt: number;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('increment_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_ms: windowMs,
    });
    if (error || !data) {
      // DB error path: fail open. The RPC is a security DEFINER
      // function so an error is unusual; a missing-function error
      // during a migration window is the most likely cause. Allow
      // the request rather than locking everyone out.
      console.warn('[rate-limit] RPC failed, allowing request', error?.message);
      return { allowed: true, count: 0, resetAt: Date.now() + windowMs };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { allowed: true, count: 0, resetAt: Date.now() + windowMs };
    }
    return {
      allowed: Boolean(row.allowed),
      count: Number(row.count) || 0,
      resetAt: row.reset_at ? new Date(row.reset_at).getTime() : Date.now() + windowMs,
    };
  } catch (e) {
    console.warn('[rate-limit] threw, allowing request', e);
    return { allowed: true, count: 0, resetAt: Date.now() + windowMs };
  }
}

/**
 * Test-only — clears all buckets from the table. Tests should reset
 * to a known state between runs.
 */
export async function __resetRateLimitsForTests(): Promise<void> {
  const admin = createAdminClient();
  await admin.from('rate_limit_buckets').delete().gt('count', -1);
}
