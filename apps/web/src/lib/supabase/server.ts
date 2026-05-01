import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { env } from '@/lib/env';
import { applyRememberSession } from '@/lib/supabase/session-cookies';

import type { Database } from '@stockpilot/core';

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

interface CreateClientOptions {
  rememberSession?: boolean;
}

/**
 * Server Supabase client — reads the user session from request cookies.
 * Use in Server Components, Server Actions, and Route Handlers.
 */
export async function createClient(options: CreateClientOptions = {}) {
  const cookieStore = await cookies();
  const rememberSession = options.rememberSession ?? true;

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
              cookieStore.set(name, value, applyRememberSession(options, rememberSession)),
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
