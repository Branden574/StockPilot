import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Where a request whose session no longer exists is sent (see
 * lib/auth/session-ended.ts). A route handler, not a page, because only a
 * handler can clear cookies: the stale ones would otherwise keep passing the
 * middleware's local token check and bounce /signin straight back to
 * /dashboard.
 *
 * 1. signOut({ scope: 'local' }) drops the stored session through the cookie
 *    adapter. GoTrue answering 401/403/404 for the already-gone session is
 *    fine; auth-js removes the local session on those.
 * 2. Belt and braces: every Supabase auth cookie the request carried is
 *    expired on the redirect itself, so no failure in step 1 can leave a
 *    loop behind.
 * 3. /signin?reason=session_ended, where the form says why.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Step 2 still clears the cookies.
  }
  const url = new URL('/signin', request.url);
  url.searchParams.set('reason', 'session_ended');
  const res = NextResponse.redirect(url);
  for (const c of request.cookies.getAll()) {
    if (/^sb-.+-auth-token(\.\d+)?$/.test(c.name)) {
      res.cookies.set(c.name, '', { path: '/', maxAge: 0 });
    }
  }
  return res;
}
