import { createClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';

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
  });
}
