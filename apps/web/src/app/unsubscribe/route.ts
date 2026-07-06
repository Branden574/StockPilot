import { NextResponse, type NextRequest } from 'next/server';

import {
  normalizeUnsubscribeEmail,
  verifyUnsubscribeToken,
} from '@/lib/email/unsubscribe';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public unsubscribe endpoint for order-request emails —
 * `/unsubscribe?e=<email>&t=<hmac>`. The recipients are anonymous
 * public requesters with no account, so this lives OUTSIDE the login
 * wall; the HMAC token (lib/email/unsubscribe.ts) is what stops the
 * endpoint from unsubscribing arbitrary addresses.
 *
 * Why GET must NOT record the opt-out: corporate/school email security
 * scanners prefetch every link within seconds of delivery (observed
 * live in this codebase 2026-07-02) — a GET-mutating unsubscribe would
 * silently opt recipients out the moment the email lands. GET renders a
 * click-through page; only POST writes. Scanners follow GET/HEAD but
 * don't submit forms. Same pattern as /auth/confirm and /r/confirm.
 *
 * POST serves two callers:
 *   - the GET page's confirm form (params in the form body), and
 *   - RFC 8058 one-click unsubscribe: Gmail/Yahoo POST
 *     `List-Unsubscribe=One-Click` to the List-Unsubscribe URL verbatim,
 *     so `e`/`t` arrive in the query string. One-click is allowed to
 *     mutate on the provider's POST — that's exactly what the header
 *     pair advertises.
 * Both are idempotent: the upsert makes a second POST land on the same
 * "you're unsubscribed" page.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Plain server-rendered HTML on purpose (mirrors /auth/confirm): zero
 * JS, renders in every mail-client browser, nothing to hydrate.
 */
function htmlPage(heading: string, bodyHtml: string, status: number): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)} · StockPilot</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <main style="max-width:400px;width:100%;margin:16px;background:white;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);text-align:center;">
    <div style="font-weight:600;font-size:18px;margin-bottom:20px;">StockPilot</div>
    <h1 style="font-size:22px;margin:0 0 10px;">${escapeHtml(heading)}</h1>
    ${bodyHtml}
  </main>
</body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // never cache a page carrying a signed token
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}

function invalidPage(): NextResponse {
  return htmlPage(
    'This link is invalid',
    `<p style="color:#52525b;font-size:14px;line-height:1.6;margin:0;">
      This unsubscribe link is invalid or was altered. Use the link from
      the bottom of a StockPilot order email.
    </p>`,
    400,
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('e');
  const token = searchParams.get('t');

  // Verification is pure computation — GET never touches the database.
  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return invalidPage();
  }

  const normalized = normalizeUnsubscribeEmail(email);
  return htmlPage(
    'Unsubscribe from order notifications?',
    `<p style="color:#52525b;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Stop sending order updates to
      <strong>${escapeHtml(normalized)}</strong>? You'll no longer get
      emails when your order requests change status.
    </p>
    <form method="post" action="/unsubscribe">
      <input type="hidden" name="e" value="${escapeHtml(normalized)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <button type="submit" style="display:inline-block;width:100%;background:#0c0c0e;color:white;border:0;cursor:pointer;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">
        Unsubscribe
      </button>
    </form>`,
    200,
  );
}

export async function POST(request: NextRequest) {
  // One-click providers POST to the List-Unsubscribe URL verbatim, so
  // prefer the query string; the human confirm form carries the same
  // pair as hidden fields instead.
  const { searchParams } = new URL(request.url);
  let email = searchParams.get('e');
  let token = searchParams.get('t');
  if (!email || !token) {
    const form = await request.formData().catch(() => null);
    email = email ?? ((form?.get('e') as string | null) ?? null);
    token = token ?? ((form?.get('t') as string | null) ?? null);
  }

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    // Non-2xx tells a one-click provider the unsubscribe did NOT happen.
    return invalidPage();
  }

  const normalized = normalizeUnsubscribeEmail(email);
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('public_email_unsubscribes')
      .upsert(
        { email: normalized },
        { onConflict: 'email', ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error('[unsubscribe] opt-out write failed', e);
    // 5xx so Gmail/Yahoo retry the one-click POST instead of assuming
    // success while the address keeps receiving email.
    return htmlPage(
      'Something went wrong',
      `<p style="color:#52525b;font-size:14px;line-height:1.6;margin:0;">
        We couldn't record your preference. Please try the link again in
        a few minutes.
      </p>`,
      500,
    );
  }

  return htmlPage(
    "You're unsubscribed",
    `<p style="color:#52525b;font-size:14px;line-height:1.6;margin:0;">
      <strong>${escapeHtml(normalized)}</strong> won't receive order
      notification emails anymore. Confirmation emails for requests you
      submit yourself may still be sent.
    </p>`,
    200,
  );
}
