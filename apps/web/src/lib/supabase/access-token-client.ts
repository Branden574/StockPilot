import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { guardedServerSupabaseFetch } from '@/lib/supabase/url-length-guard.server';

import type { Database } from '@stockpilot/core';

/**
 * A Supabase client that acts as one access token and nothing else (docket
 * S50a): every request carries `Authorization: Bearer <accessToken>`, so
 * PostgREST runs it as that token's subject, under that subject's RLS.
 *
 * It never loads, renews or stores a session, so every call runs as that
 * token's subject. A caller that has verified one account's token
 * (readVerifiedSessionTokenOf) and must act as exactly that account makes the
 * call here, with that token, instead of on the cookie client. The shape is
 * the Bearer data client's in lib/auth/api-context.ts.
 *
 * Server code only: the token is a credential. An expired token is refused by
 * PostgREST (401), never renewed here.
 */
export function createAccessTokenClient(accessToken: string) {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    // The guard refuses a PostgREST URL too long to succeed instead of letting
    // it fail after ~7 s of retries (see url-length-guard.ts).
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: guardedServerSupabaseFetch,
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
