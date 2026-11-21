import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import {
  type PasswordCheckSource,
  recordAccountCodeBlocked,
  recordSignInBlocked,
} from '@/server/security/account-events';

import type { Database } from '@stockpilot/core';

/** The request's headers, or null outside a request: never a throw. */
async function requestHeadersOrNull(): Promise<Awaited<ReturnType<typeof headers>> | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

/**
 * A SECURITY EVENT FOR A PASSWORD THE SIGN-IN SERVICE REFUSED HERE (part 1
 * of the security tools). This check sends a password to the sign-in service
 * from our own server, so its refusals appear in that service's log in our
 * server's form. Each is recorded, so that our own record holds every
 * refusal our server causes there and the reader of that log
 * (server/security/auth-logs.ts) can tell them from requests that only carry
 * our server's marks:
 *   - a password the service judged wrong (its `invalid_credentials`):
 *     wrong_current_password, in the organization of the signed-in account
 *     (looked up after the response, as a wrong code is);
 *   - any other refusal with the same status (a disabled account, for
 *     instance): sign_in_refused_other, with no organization;
 *   - the service's own limit, an outage or no answer judged no password:
 *     nothing.
 * It is also worth an admin's eye: a wrong current password is what someone
 * holding another person's open session meets before a sensitive change.
 * Both are recorded with the source the check came from: the website, or
 * the phone app through our API (the caller says which).
 *
 * Never the caller's problem: it never throws, waits only for the request's
 * headers (already in memory), and changes nothing the member is answered.
 */
async function recordRefusedPassword(
  error: { status?: unknown; code?: unknown },
  email: string,
  userId: string,
  source: PasswordCheckSource,
): Promise<void> {
  try {
    const code = typeof error.code === 'string' ? error.code : null;
    if (code === 'invalid_credentials') {
      if (typeof userId !== 'string' || userId.length === 0) return;
      recordAccountCodeBlocked(
        'wrong_current_password',
        userId,
        await requestHeadersOrNull(),
        source,
      );
      return;
    }
    // A 400 with no code is recorded too. The client library builds such an
    // error itself only when neither an email nor a phone number is given,
    // which no caller here does; so every row recorded here has a line in
    // the sign-in service's log, which is what the reader of that log
    // relies on when it counts these rows as refusals our server made.
    if (error.status === 400 && !(code !== null && /rate.?limit/i.test(code))) {
      recordSignInBlocked('sign_in_refused_other', email, await requestHeadersOrNull(), source);
    }
  } catch {
    // An event that could not be recorded is dropped.
  }
}

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
 *
 * `userId` is the signed-in account whose password this is (the account the
 * email belongs to): a refused password is recorded as a security event for
 * it (recordRefusedPassword above). `source` is where the request came
 * from: `phone` when the phone app asked through our API, the website
 * otherwise.
 */
export async function verifyPasswordSideChannel(
  email: string,
  password: string,
  userId: string,
  source: PasswordCheckSource = 'web',
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
      await recordRefusedPassword(error, email, userId, source === 'phone' ? 'phone' : 'web');
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
    // The callers answer `message` as it is (MFA set-up, recovery codes, the
    // ownership transfer, the email change), so it is a fixed sentence, never
    // the thrown error's text; the error goes to the report (S31).
    void reportError(e instanceof Error ? e : new Error(String(e)), {
      tag: 'auth.verify_password',
    });
    return {
      ok: false,
      reason: 'internal_error',
      message: 'Could not verify your current password. Please try again.',
    };
  }
}
