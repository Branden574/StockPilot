import { NextResponse, type NextRequest } from 'next/server';

import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import { completeEmailChange, EMAIL_CHANGE_RETURN_PATH } from '@/server/services/email-change';

import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * Server-side confirmation endpoint for auth emails WE send (password
 * reset, platform invites, email change) — links built from
 * `generateLink().properties.hashed_token`.
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
 *
 * EMAIL CHANGE (type=email_change, mig 0345): production runs secure email
 * change, so there are TWO links per request — one to the current address,
 * one to the new — and GoTrue applies the change only when both have been
 * verified. The first POST returns no session and changes nothing; this
 * route answers it with a "one more to go" page. The second returns a
 * session for the account (now on the new email), and the route repairs the
 * profile projection, notifies the previous address and lands on Settings →
 * Profile. `next` is IGNORED for this type: the destination is hard-coded.
 * A failed email-change link gets its own page rather than the /signin
 * bounce, because the clicker is usually a signed-in user whose account has
 * NOT changed.
 */

/** Only the email types we actually send through this route. 'magiclink' is
 *  the B2B portal invite fallback for EXISTING auth users (generateLink rejects
 *  type 'invite' for an already-registered email — see CustomersService). */
const ALLOWED_TYPES: ReadonlySet<EmailOtpType> = new Set([
  'recovery',
  'invite',
  'magiclink',
  'email_change',
]);

function failureRedirect(origin: string, type: string | null): NextResponse {
  // Expired/used/invalid link. Recovery users get sent back to the reset
  // form so they can request a fresh link in one click.
  const dest = type === 'recovery' ? '/reset?error=link_expired' : '/signin?error=auth_callback_failed';
  return NextResponse.redirect(`${origin}${dest}`, 303);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // never cache a page carrying a one-time token or describing its outcome
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

function shell(title: string, inner: string): string {
  // Plain server-rendered HTML on purpose: zero JS, works in every client,
  // and the token is only ever consumed by the human pressing the button.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · StockPilot</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <main style="max-width:400px;width:100%;margin:16px;background:white;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);text-align:center;">
    <div style="font-weight:600;font-size:18px;margin-bottom:20px;">StockPilot</div>
    ${inner}
  </main>
</body></html>`;
}

const BUTTON_STYLE =
  'display:inline-block;width:100%;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;border:0;cursor:pointer;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;box-sizing:border-box;';

function statusPage(args: { title: string; heading: string; body: string; linkLabel: string; linkHref: string }) {
  const html = shell(
    args.title,
    `<h1 style="font-size:22px;margin:0 0 10px;">${escapeHtml(args.heading)}</h1>
    <p style="color:#52525b;font-size:14px;line-height:1.6;margin:0 0 24px;">${escapeHtml(args.body)}</p>
    <a href="${escapeHtml(args.linkHref)}" style="${BUTTON_STYLE}">${escapeHtml(args.linkLabel)}</a>`,
  );
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
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
        : type === 'email_change'
          ? 'Confirm your email change'
          : 'Accept your invite';
  const button =
    type === 'recovery'
      ? 'Continue to set a new password'
      : type === 'email_change'
        ? 'Confirm email change'
        : 'Continue to StockPilot';
  const html = shell(
    heading,
    `<h1 style="font-size:22px;margin:0 0 10px;">${heading}</h1>
    <p style="color:#52525b;font-size:14px;line-height:1.6;margin:0 0 24px;">
      This link works once. Press the button to continue.
    </p>
    <form method="post" action="/auth/confirm">
      <input type="hidden" name="token_hash" value="${escapeHtml(tokenHash)}">
      <input type="hidden" name="type" value="${escapeHtml(type)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button type="submit" style="${BUTTON_STYLE}">
        ${button}
      </button>
    </form>`,
  );
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const tokenHash = (form?.get('token_hash') as string | null) ?? null;
  const type = (form?.get('type') as string | null) ?? null;
  const next = safeRedirectPath((form?.get('next') as string | null) ?? null);

  if (tokenHash && type && ALLOWED_TYPES.has(type as EmailOtpType)) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });

    if (type === 'email_change') {
      if (error) {
        return statusPage({
          title: 'Link expired',
          heading: 'This link has expired or was already used',
          body: 'Nothing about your account has changed. Open Settings → Profile to send a fresh verification.',
          linkLabel: 'Go to Settings → Profile',
          linkHref: EMAIL_CHANGE_RETURN_PATH,
        });
      }
      if (data?.session) {
        // Second of two confirmations: GoTrue has applied the change and the
        // database trigger has synced the profile. Repair + notify is
        // best-effort; the redirect must not depend on an email send.
        try {
          await completeEmailChange({ userId: data.session.user.id });
        } catch (e) {
          void reportError(e, { tag: 'auth.email_change_complete_failed', level: 'warning' });
        }
        return NextResponse.redirect(`${origin}${EMAIL_CHANGE_RETURN_PATH}?emailChanged=1`, 303);
      }
      // First of two confirmations: nothing has changed yet.
      return statusPage({
        title: 'One more confirmation',
        heading: 'One confirmation done — one to go',
        body: 'Secure email change needs both addresses to confirm. Check the other inbox for its link. Your account keeps using the current email until then.',
        linkLabel: 'Go to Settings → Profile',
        linkHref: EMAIL_CHANGE_RETURN_PATH,
      });
    }

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`, 303);
    }
  }

  return failureRedirect(origin, type);
}
