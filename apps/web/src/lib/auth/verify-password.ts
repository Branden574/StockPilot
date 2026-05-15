import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';

import type { Database } from '@stockpilot/core';

/**
 * Out-of-band password verification. Spins up an isolated Supabase
 * client (no cookie persistence) and tries `signInWithPassword`. On
 * success returns `true` WITHOUT touching the caller's SSR cookie
 * session — critical for AAL2 sessions, since a fresh password sign-in
 * resets the calling session back to AAL1 and breaks subsequent
 * security-sensitive mutations.
 *
 * Why this exists as a shared helper: every flow that demands a
 * password re-confirm (change-password, MFA enroll verify, MFA
 * recovery consume) needs the same dance — keep it in one place so
 * the rate-limit and side-channel discipline doesn't drift.
 *
 * Callers are responsible for their own rate-limiting; this helper
 * does NOT enforce a brute-force ceiling.
 */
export async function verifyPasswordSideChannel(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; reason: 'invalid_password' | 'internal_error'; message: string }> {
  try {
    const client = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      return { ok: false, reason: 'invalid_password', message: 'Password is incorrect.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: 'internal_error',
      message: e instanceof Error ? e.message : 'Password verification failed',
    };
  }
}
