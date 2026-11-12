import type { CookieOptions } from '@supabase/ssr';

export const REMEMBER_SESSION_COOKIE = 'stockpilot-remember-session';
export const REMEMBER_SESSION_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * The names of the Supabase auth cookies: the session, and each chunk of it
 * (`.0`, `.1`, ...) when it is too long for one cookie. The same pattern
 * app/auth/session-ended/route.ts expires; the PKCE code-verifier cookie
 * (`...-auth-token-code-verifier`) is not one of them.
 */
export const SUPABASE_AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

export function applyRememberSession(
  options: CookieOptions | undefined,
  rememberSession: boolean,
): CookieOptions | undefined {
  if (rememberSession) return options;

  const sessionOptions = { ...(options ?? {}) };
  delete sessionOptions.maxAge;
  delete sessionOptions.expires;
  return sessionOptions;
}

export function rememberPreferenceOptions(rememberSession: boolean): CookieOptions {
  return {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    ...(rememberSession ? { maxAge: REMEMBER_SESSION_MAX_AGE } : {}),
  };
}
