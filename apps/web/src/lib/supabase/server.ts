import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { env } from '@/lib/env';

import type { Database } from '@stockpilot/core';

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * Server Supabase client — reads the user session from request cookies.
 * Use in Server Components, Server Actions, and Route Handlers.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `set` is a no-op outside of Server Actions / Route Handlers.
            // Middleware handles refresh; ignore.
          }
        },
      },
    },
  );
}
