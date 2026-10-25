import { NextResponse, type NextRequest } from 'next/server';

import { sentFromAnotherOrigin } from '@/lib/auth/cross-site-request';
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
 *
 * ANOTHER ORIGIN CANNOT END A LIVE SESSION (docket S14 review). This is a GET,
 * which the cross-site write rule never judges, and the browser sends the
 * session cookie with a top-level navigation from any site (SameSite=Lax) and
 * with an image or script that a sibling subdomain loads (the same site). So
 * any page could sign the person out with a link, a redirect or an <img>, which
 * is also the first step of a login CSRF (sign them out, then offer a sign-in
 * link for an account the attacker holds). When the browser says a page on
 * another origin made this request (lib/auth/cross-site-request.ts,
 * sentFromAnotherOrigin), only a session that is ALREADY gone is cleared: that
 * is what the dashboard's own redirect sends here for, and it must still work
 * when the person arrived by a link on another site (the browser then reports
 * the whole redirect chain as cross-site). A live session is left alone and the
 * browser goes to the dashboard.
 *
 * "Live" means GoTrue answered with the user. Any other answer, or a check that
 * throws, is treated as gone and cleared as before. That keeps this route free
 * of loops by construction: the dashboard only redirects here when GoTrue said
 * the session is missing, and a missing session never answers with a user. It
 * costs a sign-out only while GoTrue cannot answer, which no page can cause.
 * The app's own pages (the error screens' "Sign out and back in" button, which
 * loads this route in its own tab: Sec-Fetch-Site same-origin), the person's
 * own act (a typed address or a bookmark, `none`) and a browser that sends no
 * Fetch Metadata sign out as before.
 */
export async function GET(request: NextRequest) {
  if (sentFromAnotherOrigin(request) && (await sessionIsLive())) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

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

/** True only when GoTrue answers with the user this browser's session belongs to. */
async function sessionIsLive(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return Boolean(user);
  } catch {
    return false;
  }
}
