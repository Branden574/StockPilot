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
 * Failure mode: by default we fail OPEN — return allowed=true with a
 * placeholder reset. Failing closed would soft-DoS authenticated
 * surfaces during a transient DB blip; we'd rather log + allow than
 * stonewall legitimate users.
 *
 * For unauthenticated public endpoints where an open failure mode can
 * be abused (the bucket lookup throwing == infinite request budget),
 * pass `mode: 'closed'` to flip the catch path to deny.
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
  mode: 'open' | 'closed' = 'open',
): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('increment_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_ms: windowMs,
    });
    if (error || !data) {
      // DB error path. By default we fail open (auth'd surfaces); when
      // `mode === 'closed'` (public endpoints) we deny instead so a
      // DB outage can't unlock unlimited submissions.
      if (mode === 'closed') {
        console.warn('[rate-limit] RPC failed, denying request (closed mode)', error?.message);
        return { allowed: false, count: limit, resetAt: Date.now() + windowMs };
      }
      console.warn('[rate-limit] RPC failed, allowing request', error?.message);
      return { allowed: true, count: 0, resetAt: Date.now() + windowMs };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      if (mode === 'closed') {
        return { allowed: false, count: limit, resetAt: Date.now() + windowMs };
      }
      return { allowed: true, count: 0, resetAt: Date.now() + windowMs };
    }
    return {
      allowed: Boolean(row.allowed),
      count: Number(row.count) || 0,
      resetAt: row.reset_at ? new Date(row.reset_at).getTime() : Date.now() + windowMs,
    };
  } catch (e) {
    if (mode === 'closed') {
      console.warn('[rate-limit] threw, denying request (closed mode)', e);
      return { allowed: false, count: limit, resetAt: Date.now() + windowMs };
    }
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
