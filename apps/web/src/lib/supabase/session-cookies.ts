import type { CookieOptions } from '@supabase/ssr';

export const REMEMBER_SESSION_COOKIE = 'stockpilot-remember-session';
export const REMEMBER_SESSION_MAX_AGE = 400 * 24 * 60 * 60;

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
