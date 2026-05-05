import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { applyRememberSession, REMEMBER_SESSION_COOKIE } from '@/lib/supabase/session-cookies';

import type { Database } from '@stockpilot/core';

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

const PROTECTED_PREFIXES = ['/dashboard', '/onboarding'];
const AUTH_ROUTES = ['/signin', '/signup', '/reset'];

/** Header keys forwarded from middleware to the page render. */
export const SESSION_HEADER_USER_ID = 'x-stockpilot-user-id';
export const SESSION_HEADER_USER_EMAIL = 'x-stockpilot-user-email';

/**
 * Refreshes the Supabase session on every request and gates protected routes.
 * After validating with auth.getUser() (the only secure path), exposes the
 * user id + email as request headers so server components can trust them
 * without making a second round trip to the Auth API.
 */
export async function updateSession(request: NextRequest) {
  // Track any cookies the supabase client wants to set (token refreshes).
  const pendingCookies: CookieToSet[] = [];
  const rememberSession = request.cookies.get(REMEMBER_SESSION_COOKIE)?.value !== '0';

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            // Mirror onto the request so subsequent reads in the same call
            // see the fresh values.
            request.cookies.set(name, value);
            pendingCookies.push({
              name,
              value,
              options: applyRememberSession(options, rememberSession),
            });
          });
        },
      },
    },
  );

  // The single auth.getUser() call per request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  // /signin/mfa is intentionally reachable WHILE signed in at AAL1 — that's
  // the whole point of the challenge page. Treating it as a generic auth
  // route caused a redirect loop with the dashboard layout's MFA gate.
  const isAuthRoute =
    AUTH_ROUTES.some((p) => pathname.startsWith(p)) &&
    pathname !== '/signin/mfa' &&
    !pathname.startsWith('/signin/mfa/');

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('redirect', `${pathname}${search}`);
    const redirectRes = NextResponse.redirect(url);
    pendingCookies.forEach(({ name, value, options }) =>
      redirectRes.cookies.set(name, value, options),
    );
    return redirectRes;
  }

  if (isAuthRoute && user) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    const redirectRes = NextResponse.redirect(url);
    pendingCookies.forEach(({ name, value, options }) =>
      redirectRes.cookies.set(name, value, options),
    );
    return redirectRes;
  }

  // Forward the validated identity downstream as headers.
  const requestHeaders = new Headers(request.headers);
  // Pathname is exposed so layouts/RSCs can branch on the current route
  // without re-parsing the URL (server components don't have usePathname).
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  if (user) {
    requestHeaders.set(SESSION_HEADER_USER_ID, user.id);
    requestHeaders.set(SESSION_HEADER_USER_EMAIL, user.email ?? '');
  } else {
    requestHeaders.delete(SESSION_HEADER_USER_ID);
    requestHeaders.delete(SESSION_HEADER_USER_EMAIL);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Apply any token-refresh cookies onto the final response.
  pendingCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  return response;
}
