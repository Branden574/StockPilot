import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

/**
 * OAuth + magic-link + email-confirm callback.
 * Receives ?code=… from Supabase, exchanges it for a session, then redirects.
 */
/**
 * Validate a `next=` param so it can only redirect to a same-origin
 * relative path. `//evil.com` and `/\evil.com` were both treated as
 * protocol-relative URLs by some clients (Chrome, curl -L), giving
 * an OAuth-code-theft / phishing landing-page attacker control over
 * where a freshly-signed-in user gets sent. Accept only paths that
 * start with `/` and don't start with `//` or `/\`.
 */
function safeRedirectPath(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/')) return '/dashboard';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeRedirectPath(searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=auth_callback_failed`);
}
