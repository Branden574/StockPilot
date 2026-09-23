import { createClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { guardedSupabaseFetch } from '@/lib/supabase/url-length-guard';

import type { Database } from '@stockpilot/core';

/**
 * Service-role Supabase client — bypasses RLS. Use ONLY in trusted server
 * contexts (webhooks, scheduled jobs, admin tools). Never import from a
 * Client Component or expose this to the browser.
 */
export function createAdminClient() {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // Refuses a PostgREST URL too long to succeed instead of letting it fail
    // after ~7 s of retries (see url-length-guard.ts).
    global: { fetch: guardedSupabaseFetch },
  });
}
