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
 * screen", 2026-07-02).
 *
 * Why GET must NOT consume the token: corporate/school email security
 * scanners prefetch links within seconds of delivery (observed live
 * 2026-07-02: a recovery link consumed by a GET 28s after the email was
 * sent, before the human ever clicked — their real click then hit
 * "token not found"). GET renders a click-through page; only the form's
 * POST calls verifyOtp. Scanners follow GET/HEAD but don't submit forms.
 */

/** Same-origin relative-path guard — mirrors /auth/callback. */
function safeRedirectPath(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/')) return '/dashboard';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}

/** Only the email types we actually send through this route. 'magiclink' is
 *  the B2B portal invite fallback for EXISTING auth users (generateLink rejects
 *  type 'invite' for an already-registered email — see CustomersService). */
const ALLOWED_TYPES: ReadonlySet<EmailOtpType> = new Set(['recovery', 'invite', 'magiclink']);

function failureRedirect(origin: string, type: string | null): NextResponse {
  // Expired/used/invalid link. Recovery users get sent back to the reset
  // form so they can request a fresh link in one click.
  const dest = type === 'recovery' ? '/reset?error=link_expired' : '/signin?error=auth_callback_failed';
  return NextResponse.redirect(`${origin}${dest}`, 303);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = safeRedirectPath(searchParams.get('next'));

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type as EmailOtpType)) {
    return failureRedirect(origin, type);
  }

  const heading =
    type === 'recovery'
      ? 'Reset your password'
      : type === 'magiclink'
        ? 'Sign in'
        : 'Accept your invite';
  const button =
    type === 'recovery' ? 'Continue to set a new password' : 'Continue to StockPilot';
  // Plain server-rendered HTML on purpose: zero JS, works in every client,
  // and the token is only ever consumed by the human pressing the button.
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} · StockPilot</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <main style="max-width:400px;width:100%;margin:16px;background:white;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);text-align:center;">
    <div style="font-weight:600;font-size:18px;margin-bottom:20px;">StockPilot</div>
    <h1 style="font-size:22px;margin:0 0 10px;">${heading}</h1>
    <p style="color:#52525b;font-size:14px;line-height:1.6;margin:0 0 24px;">
      This link works once. Press the button to continue.
    </p>
    <form method="post" action="/auth/confirm">
      <input type="hidden" name="token_hash" value="${escapeHtml(tokenHash)}">
      <input type="hidden" name="type" value="${escapeHtml(type)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button type="submit" style="display:inline-block;width:100%;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;border:0;cursor:pointer;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">
        ${button}
      </button>
    </form>
  </main>
</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // never cache a page carrying a one-time token
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const tokenHash = (form?.get('token_hash') as string | null) ?? null;
  const type = (form?.get('type') as string | null) ?? null;
  const next = safeRedirectPath((form?.get('next') as string | null) ?? null);

  if (tokenHash && type && ALLOWED_TYPES.has(type as EmailOtpType)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`, 303);
    }
  }

  return failureRedirect(origin, type);
}
