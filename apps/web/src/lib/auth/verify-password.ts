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

    // Revoke the session this check just minted — otherwise it is a GHOST.
    //
    // `persistSession: false` (above) only suppresses CLIENT-side storage; it
    // does NOT stop GoTrue's password grant from inserting a real
    // `auth.sessions` row with a live refresh token. `list_my_sessions`
    // (migs 0213/0214) returns EVERY auth.sessions row for auth.uid() with no
    // filter, so every email-change request, ownership transfer, MFA
    // enroll-verify and recovery-code consume was adding a phantom entry to
    // Settings → Security — indistinguishable from the user's real web
    // sessions (server.ts forwards no User-Agent, so SSR sign-ins log as
    // 'node' too). Users seeing a device they didn't create reasonably press
    // "Sign out other devices" and evict their own phone. Prod had 24 such
    // server-originated rows, 10 never refreshed.
    //
    // scope 'local' is deliberate: auth-js still POSTs /logout?scope=local
    // with THIS client's own access token (GoTrueClient._signOut calls
    // admin.signOut for every scope), so GoTrue deletes exactly the session
    // just created and nothing else. 'global'/'others' would evict the
    // caller's SSR cookie session and their real devices mid-flow.
    //
    // Best-effort: the password IS verified at this point. A GoTrue /logout
    // blip must not turn a correct password into "Password is incorrect" and
    // lock the user out of email change / MFA enroll — a leaked ghost is the
    // pre-fix status quo, so failing here degrades to exactly the old
    // behaviour instead of a new outage.
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch (e) {
      console.warn('[verifyPasswordSideChannel] ghost-session cleanup failed:', e);
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
