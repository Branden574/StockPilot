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

const PROTECTED_PREFIXES = ['/dashboard', '/platform', '/onboarding'];
const AUTH_ROUTES = ['/signin', '/signup', '/reset'];

/** Header keys forwarded from middleware to the page render. */
export const SESSION_HEADER_USER_ID = 'x-stockpilot-user-id';
export const SESSION_HEADER_USER_EMAIL = 'x-stockpilot-user-email';

/**
 * Refreshes the Supabase session on every request and gates protected routes.
 * After CRYPTOGRAPHICALLY verifying the session (auth.getClaims() local ES256
 * verify on the warm path, auth.getUser() network verify as the fallback),
 * exposes the user id + email as request headers so server components can
 * trust them without making a second round trip to the Auth API.
 *
 * TRUST CHAIN (cited by src/lib/auth/platform-admin.ts + src/lib/auth/session.ts
 * — keep those comments in sync): the identity headers are set ONLY after one
 * of the two verification paths above succeeds, and are unconditionally
 * DELETED otherwise, so a client-supplied header can never survive.
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

  // ── Session verification: local-first, network only when needed ────
  //
  // FAST PATH — auth.getClaims() (cold-start perf plan item 1): verifies the
  // session JWT LOCALLY with WebCrypto against the project's asymmetric ES256
  // signing key (JWKS fetched from /auth/v1/.well-known/jwks.json and held in
  // a module-GLOBAL cache shared by every per-request client in this runtime,
  // 10-min TTL — see GLOBAL_JWKS in @supabase/auth-js). This removes the
  // per-request GoTrue round trip (~40-150ms of TTFB) that getUser() paid.
  //
  // Token REFRESH still works: no-arg getClaims() loads the session via
  // getSession(), which refreshes an expired/near-expiry (≤90s) access token
  // over the network first — the "returning after >1h idle" user gets fresh
  // cookies through the same setAll plumbing above, THEN a local verify.
  // On an HS256 token or missing WebCrypto, getClaims() itself falls back to
  // a getUser() network verify, so local dev (HS256) keeps working unchanged.
  //
  // SECURITY — revocation semantics: a locally-verified token is accepted
  // until exp even if the session was revoked server-side. This matches the
  // enforcement level of the actual data boundary: Postgres RLS also accepts
  // any validly-signed unexpired JWT without consulting GoTrue. Revocation UX
  // is handled by the device-eviction broadcast (sign-out/password-reset fire
  // it; listeners sign out in ~1s). Every stronger-than-RLS gate (platform
  // admin, AAL2, step-up) makes its OWN live auth calls — see
  // src/lib/auth/platform-admin.ts.
  //
  // SLOW PATH — when the fast path can't establish identity (no session,
  // failed refresh, JWKS fetch hiccup, malformed cookie), fall back to
  // exactly the pre-getClaims behavior: one auth.getUser() network round
  // trip. With no session at all this returns immediately without a network
  // call, so anonymous requests don't regress.
  let userId: string | null = null;
  let userEmail: string | null = null;

  try {
    const { data: claimsData } = await supabase.auth.getClaims();
    if (claimsData?.claims.sub) {
      userId = claimsData.claims.sub;
      userEmail = claimsData.claims.email ?? null;
    }
  } catch {
    // getClaims() rethrows non-Auth errors (e.g. WebCrypto import failures on
    // a garbage JWK). Never 500 the whole request over that — let the slow
    // path give the authoritative answer.
  }

  if (userId === null) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      userId = user.id;
      userEmail = user.email ?? null;
    }
  }

  const { pathname, search } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  // /signin/mfa is intentionally reachable WHILE signed in at AAL1 — that's
  // the whole point of the challenge page. Treating it as a generic auth
  // route caused a redirect loop with the dashboard layout's MFA gate.
  //
  // ALL of /reset is similarly reachable while signed in:
  //   - /reset/complete: the recovery flow establishes a real session
  //     BEFORE the user lands on the form (verifyOtp in /auth/confirm),
  //     so updateUser({ password }) can authenticate as them. Bouncing
  //     them to /dashboard before they pick a new password breaks the
  //     whole reset flow.
  //   - /reset itself: /auth/confirm redirects expired/used links to
  //     /reset?error=link_expired. When the clicker already had a
  //     session, the old rule bounced that to /dashboard — the user saw
  //     "clicked the email and it just signed me back in" with no
  //     explanation (owner-reported 2026-07-02). A signed-in user
  //     requesting a reset link is harmless, so exempt the whole tree.
  const isAuthRoute =
    AUTH_ROUTES.some((p) => pathname.startsWith(p)) &&
    pathname !== '/signin/mfa' &&
    !pathname.startsWith('/signin/mfa/') &&
    pathname !== '/reset' &&
    !pathname.startsWith('/reset/');

  if (isProtected && !userId) {
    const url = request.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('redirect', `${pathname}${search}`);
    const redirectRes = NextResponse.redirect(url);
    pendingCookies.forEach(({ name, value, options }) =>
      redirectRes.cookies.set(name, value, options),
    );
    return redirectRes;
  }

  if (isAuthRoute && userId) {
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
  if (userId) {
    requestHeaders.set(SESSION_HEADER_USER_ID, userId);
    requestHeaders.set(SESSION_HEADER_USER_EMAIL, userEmail ?? '');
  } else {
    requestHeaders.delete(SESSION_HEADER_USER_ID);
    requestHeaders.delete(SESSION_HEADER_USER_EMAIL);
  }

  // ── Per-request CSP nonce (plumbing only — not yet enforcing) ─────
  // Generate a per-request nonce and forward it via x-nonce so server
  // components / `next/script` can read it. This is the prep work for
  // a future strict-dynamic CSP (Next.js auto-tags its bootstrap
  // scripts with the nonce when the CSP response header contains
  // 'nonce-XYZ' — see https://nextjs.org/docs/app/guides/content-security-policy).
  //
  // The PREVIOUS attempt to enable 'strict-dynamic' broke the
  // dashboard because it lived in next.config.ts (build-time, no
  // per-request nonce). Even now that the nonce IS per-request, we
  // ship the pipeline first WITHOUT changing CSP enforcement, so we
  // can verify in browser devtools that Next is auto-tagging its
  // scripts before we tighten. The active CSP still comes from
  // next.config.ts and still relies on 'unsafe-inline'.
  const nonce = btoa(crypto.randomUUID()).replace(/=/g, '');
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Apply any token-refresh cookies onto the final response.
  pendingCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  return response;
}
