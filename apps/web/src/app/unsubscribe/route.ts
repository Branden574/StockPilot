import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { verifyMemberUnsubscribeToken, type MemberEmailKind } from '@/lib/email/member-unsubscribe';
import {
  normalizeUnsubscribeEmail,
  verifyUnsubscribeToken,
} from '@/lib/email/unsubscribe';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { unsubscribeMemberEmail } from '@/server/services/member-email-unsubscribe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public unsubscribe endpoint, for two kinds of link:
 *
 *   - order-request emails — `/unsubscribe?e=<email>&t=<hmac>`. The
 *     recipients are anonymous public requesters with no account; the
 *     HMAC token (lib/email/unsubscribe.ts) is what stops the endpoint
 *     from unsubscribing arbitrary addresses, and the opt-out lands in
 *     public_email_unsubscribes.
 *   - member emails (the weekly digest and its preview, schedule
 *     reminders; B15) — `/unsubscribe?m=<kind>.<user>.<org>.<hmac>`
 *     (lib/email/member-unsubscribe.ts). The opt-out is the member's own
 *     switch on the Notifications page
 *     (services/member-email-unsubscribe.ts), honoured only while the
 *     member still belongs to the organization the link names. Every
 *     refusal — a changed link, an unknown kind, a removed member — is the
 *     same page, so a link says nothing about the account behind it.
 *
 * Both live OUTSIDE the login wall (the proxy does not match this path, and
 * nothing here reads a session): a member reading the email signed out, and
 * a mail provider's one-click POST, have no session to offer.
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
 *
 * Rate limits (POST only, like the other public routes, failing CLOSED):
 * per link (its sha256, never the link itself) and per address. They are
 * checked after the signature, so a forged link costs no database call at
 * all, and before any read or write. GET does no database work to protect:
 * the signature check is pure computation, and a limiter there would only
 * add a database write for every scanner prefetch.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The page's own palette (redesign P5.1, as /auth/confirm): the app's light
 * ground, card and hairline, the ink button for committing the opt-out, and a
 * dark scheme for devices set to dark. A style element in the page itself: no
 * app CSS, font or script loads here (CSP allows inline styles).
 */
const PAGE_STYLE = `
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafaf7;color:#0e0f0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:400px;width:100%;margin:16px;box-sizing:border-box;background:#ffffff;border:1px solid #e7e5dd;border-radius:8px;padding:32px 28px;text-align:center}
.brand{font-weight:600;font-size:15px;letter-spacing:-0.02em;margin-bottom:20px}
h1{font-size:22px;font-weight:500;letter-spacing:-0.02em;line-height:1.25;margin:0 0 10px}
p{color:#5a5d56;font-size:14px;line-height:1.6;margin:0}
p.lead{margin:0 0 24px}
strong{color:#0e0f0d;font-weight:600}
a{color:#0e0f0d;font-weight:500;text-underline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:44px;box-sizing:border-box;padding:10px 20px;border:1px solid transparent;border-radius:6px;background:#0e0f0d;color:#fafaf7;font:inherit;font-weight:500;font-size:15px;cursor:pointer}
.btn:hover{background:#2a2c28}
.btn:focus-visible{outline:2px solid #2f7463;outline-offset:2px}
@media (prefers-color-scheme:dark){
body{background:#0c0d0a;color:#f0efe8}
main{background:#131410;border-color:#1f201b}
p{color:#9a9b91}
strong{color:#f0efe8}
a{color:#f0efe8}
.btn{background:#f0efe8;color:#0c0d0a}
.btn:hover{background:#d8d6cc}
.btn:focus-visible{outline-color:#7acdb8}
}`;

/**
 * Plain server-rendered HTML on purpose (mirrors /auth/confirm): zero
 * JS, renders in every mail-client browser, nothing to hydrate.
 */
function htmlPage(
  heading: string,
  bodyHtml: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)} · StockPilot</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <div class="brand">StockPilot</div>
    <h1>${escapeHtml(heading)}</h1>
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
      ...extraHeaders,
    },
  });
}

function invalidPage(): NextResponse {
  return htmlPage(
    'This link is invalid',
    `<p>
      This unsubscribe link is invalid or was altered. Use the link from
      the bottom of a StockPilot order email.
    </p>`,
    400,
  );
}

function errorPage(): NextResponse {
  return htmlPage(
    'Something went wrong',
    `<p>
      We couldn't record your preference. Please try the link again in
      a few minutes.
    </p>`,
    500,
  );
}

// ── Member emails (B15) ──────────────────────────────────────────────

/** Where a member chooses their emails when signed in. */
const SETTINGS_PATH = '/dashboard/settings/notifications';

/**
 * The one page for every member-link refusal: a changed or forged link, an
 * unknown kind, a link signed with no signing value configured, a member who
 * no longer belongs to the organization, and an account that is gone or
 * disabled. The same status and the same bytes for all of them, so a link
 * never tells anyone whether an account or a membership exists.
 */
function memberInvalidPage(): NextResponse {
  return htmlPage(
    "This link isn't valid",
    `<p class="lead">
      This unsubscribe link was changed, or it's no longer active. To choose
      which emails StockPilot sends you, sign in and open Settings, then
      Notifications.
    </p>
    <p><a href="${SETTINGS_PATH}">Open notification settings</a></p>`,
    400,
  );
}

/** Copy per kind: what the switch is, in the Notifications page's words. */
const MEMBER_COPY: Record<
  MemberEmailKind,
  { confirmHeading: string; confirmLead: string; doneBody: string }
> = {
  weekly_digest: {
    confirmHeading: 'Unsubscribe from the weekly digest?',
    confirmLead:
      "You'll stop getting the weekly inventory digest email. This is a setting on your " +
      'StockPilot account, so it stops the digest from every workspace you belong to.',
    doneBody:
      "You won't get the weekly inventory digest anymore. To turn it back on, sign in to " +
      'StockPilot and open Settings, then Notifications.',
  },
  schedule_reminders: {
    confirmHeading: 'Unsubscribe from schedule reminder emails?',
    confirmLead:
      "You'll stop getting the emails sent 24 hours and 1 hour before scheduled events. " +
      "Reminders in the app and on your phone don't change. This is a setting on your " +
      'StockPilot account, so it covers every workspace you belong to.',
    doneBody:
      "You won't get schedule reminder emails anymore. Reminders in the app and on your " +
      'phone still arrive. To turn the emails back on, sign in to StockPilot and open ' +
      'Settings, then Notifications.',
  },
};

function memberConfirmPage(link: string, kind: MemberEmailKind): NextResponse {
  const copy = MEMBER_COPY[kind];
  return htmlPage(
    copy.confirmHeading,
    `<p class="lead">
      ${escapeHtml(copy.confirmLead)}
    </p>
    <form method="post" action="/unsubscribe">
      <input type="hidden" name="m" value="${escapeHtml(link)}">
      <button type="submit" class="btn">
        Unsubscribe
      </button>
    </form>`,
    200,
  );
}

function memberDonePage(kind: MemberEmailKind): NextResponse {
  return htmlPage(
    "You're unsubscribed",
    `<p>
      ${escapeHtml(MEMBER_COPY[kind].doneBody)}
    </p>`,
    200,
  );
}

// ── Rate limits (POST) ───────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
/** POSTs per link per hour: a person's clicks plus a provider's retries. */
const POSTS_PER_LINK_PER_HOUR = 20;
/**
 * POSTs per address per hour. Generous: a mail provider sends every
 * recipient's one-click POST from its own small set of addresses.
 */
const POSTS_PER_IP_PER_HOUR = 120;

/**
 * The limiter's answer for a POST whose link already verified, or null when
 * it may go on. The link bucket is keyed by the link's sha256 (a raw link in
 * rate_limit_buckets would be a working unsubscribe link at rest). An address
 * that cannot be resolved skips its bucket rather than sharing one counter
 * with every other such caller (the /m share page's rule); the link bucket
 * still applies.
 */
async function postRateLimited(link: string, ip: string): Promise<NextResponse | null> {
  const linkKey = `unsubscribe:link:${createHash('sha256').update(link.toLowerCase()).digest('hex')}`;
  const checks = [checkRateLimit(linkKey, POSTS_PER_LINK_PER_HOUR, ONE_HOUR_MS, 'closed')];
  if (ip !== 'unknown') {
    checks.push(
      checkRateLimit(`unsubscribe:ip:${ip}`, POSTS_PER_IP_PER_HOUR, ONE_HOUR_MS, 'closed'),
    );
  }
  const denied = (await Promise.all(checks)).find((r) => !r.allowed);
  if (!denied) return null;
  const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
  return htmlPage(
    'Too many tries',
    `<p>
      Wait a few minutes, then use the link again.
    </p>`,
    429,
    { 'retry-after': String(retryAfter) },
  );
}

/** A form field as a string; a file or a missing field is null. */
function formString(form: FormData | null, name: string): string | null {
  const value = form?.get(name);
  return typeof value === 'string' ? value : null;
}

async function memberPost(request: NextRequest, link: string): Promise<NextResponse> {
  // Pure computation first: a forged link never reaches the limiter or the
  // database.
  const claim = verifyMemberUnsubscribeToken(link);
  // Non-2xx tells a one-click provider the unsubscribe did NOT happen.
  if (!claim) return memberInvalidPage();

  const ip = clientIpFromRequest(request);
  const limited = await postRateLimited(link, ip);
  if (limited) return limited;

  try {
    const outcome = await unsubscribeMemberEmail(createAdminClient(), claim, {
      ip: ip === 'unknown' ? null : ip,
      userAgent: request.headers.get('user-agent'),
    });
    // Only a change made (or already made) is a success; every refusal (a
    // removed member, a deleted or disabled account, and anything added
    // later) is the forged-link page.
    if (outcome === 'unsubscribed' || outcome === 'already_unsubscribed') {
      return memberDonePage(claim.kind);
    }
    return memberInvalidPage();
  } catch (e) {
    // Never the link in the report: it is a working unsubscribe link.
    void reportError(e, {
      tag: 'unsubscribe.member.write_failed',
      extra: { kind: claim.kind, organizationId: claim.organizationId },
    });
    // 5xx so Gmail/Yahoo retry the one-click POST instead of assuming
    // success while the member keeps receiving email.
    return errorPage();
  }
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // A member link wins over address parameters in the same URL.
  const link = searchParams.get('m');
  if (link !== null) {
    // Verification is pure computation — GET never touches the database.
    const claim = verifyMemberUnsubscribeToken(link);
    return claim ? memberConfirmPage(link, claim.kind) : memberInvalidPage();
  }

  const email = searchParams.get('e');
  const token = searchParams.get('t');

  // Verification is pure computation — GET never touches the database.
  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return invalidPage();
  }

  const normalized = normalizeUnsubscribeEmail(email);
  return htmlPage(
    'Unsubscribe from order notifications?',
    `<p class="lead">
      Stop sending order updates to
      <strong>${escapeHtml(normalized)}</strong>? You'll no longer get
      emails when your order requests change status.
    </p>
    <form method="post" action="/unsubscribe">
      <input type="hidden" name="e" value="${escapeHtml(normalized)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <button type="submit" class="btn">
        Unsubscribe
      </button>
    </form>`,
    200,
  );
}

export async function POST(request: NextRequest) {
  // One-click providers POST to the List-Unsubscribe URL verbatim, so
  // prefer the query string; the human confirm form carries the same
  // values as hidden fields instead.
  const { searchParams } = new URL(request.url);
  let link = searchParams.get('m');
  let email = searchParams.get('e');
  let token = searchParams.get('t');
  if (link === null && (!email || !token)) {
    const form = await request.formData().catch(() => null);
    link = formString(form, 'm');
    email = email ?? formString(form, 'e');
    token = token ?? formString(form, 't');
  }

  if (link !== null) return memberPost(request, link);

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    // Non-2xx tells a one-click provider the unsubscribe did NOT happen.
    return invalidPage();
  }

  const limited = await postRateLimited(token, clientIpFromRequest(request));
  if (limited) return limited;

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
    return errorPage();
  }

  return htmlPage(
    "You're unsubscribed",
    `<p>
      <strong>${escapeHtml(normalized)}</strong> won't receive order
      notification emails anymore. Confirmation emails for requests you
      submit yourself may still be sent.
    </p>`,
    200,
  );
}
