import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * Server-side confirmation endpoint for auth emails WE send (password
 * reset, platform invites) — links built from `generateLink().properties
 * .hashed_token`.
 *
 * Why not reuse /auth/callback: that route exchanges a PKCE `?code=`.
 * A generateLink action_link goes through Supabase's /auth/v1/verify,
 * which returns the session in the URL FRAGMENT — invisible to any
 * server route — so the callback saw no code and bounced users to
 * /signin ("hitting forgot password sends me back to the sign in
 * screen", 2026-07-02). The SSR-correct flow is: email a link to THIS
 * route carrying `token_hash`, verify it server-side with
 * `auth.verifyOtp()` (which sets the session cookies), then redirect.
 */

/** Same-origin relative-path guard — mirrors /auth/callback. */
function safeRedirectPath(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/')) return '/dashboard';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}

/** Only the email types we actually send through this route. */
const ALLOWED_TYPES: ReadonlySet<EmailOtpType> = new Set(['recovery', 'invite']);

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = safeRedirectPath(searchParams.get('next'));

  if (tokenHash && type && ALLOWED_TYPES.has(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Expired/used/invalid link. Recovery users get sent back to the reset
  // form so they can request a fresh link in one click.
  const dest = type === 'recovery' ? '/reset?error=link_expired' : '/signin?error=auth_callback_failed';
  return NextResponse.redirect(`${origin}${dest}`);
}
