'use client';

import { createBrowserClient } from '@supabase/ssr';

import { env } from '@/lib/env.client';

import type { Database } from '@stockpilot/core';

export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
