import { NextResponse, type NextRequest } from 'next/server';

import { fetchSiteIsElsewhere } from '@/lib/auth/cross-site-request';
import { readSignInAlertLink, signInAlertLinkInWindow } from '@/lib/auth/sign-in-alert-link';
import { verifySignInAlertLink } from '@/lib/auth/sign-in-alert-url';
import { signInAlertKindWords, signInAlertPlaceWords } from '@/lib/auth/sign-in-alert-words';
import { clientIpForRecord, clientIpFromRequest } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  readSignInAlert,
  reportSignInAlertNotMe,
  type SignInAlertRecord,
} from '@/server/services/sign-in-alert-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The page the "This was not me" button of a sign-in alert email opens (part
 * 3 of the security tools): /sign-in-alert?a=<alert>&i=<day>&t=<tag>
 * (lib/auth/sign-in-alert-link.ts). It lives OUTSIDE the login wall (proxy.ts
 * does not match this path, and nothing here reads a session): the member may
 * open it signed out, on another device, or after someone else has changed
 * their password.
 *
 * GET CHANGES NOTHING. Mail scanners open every link in an email within
 * seconds of delivery, so GET only shows what the alert was (the member's own
 * words for the device, the place, the time) and one button. Nothing is
 * written and no limiter is counted: the link check is computation and one
 * read. POST, from that page's own form, does the report
 * (server/services/sign-in-alert-report.ts): the alert is marked, every
 * session of the account ends, the owners and admins are told.
 *
 * ONE PAGE FOR EVERY BAD LINK. A link out of shape, past its 7 days, with a
 * changed tag, with a tag made for another account, or for an alert that does
 * not exist gets the same page, byte for byte, on GET and on POST, so the
 * page never tells a real alert id from a made-up one. The checks run from
 * cheapest to dearest: shape and window are computation and turn an old link
 * away before any read; then the alert is read (its account comes from the
 * row, never from the request) and the tag is checked against it in constant
 * time. When there is no such alert a tag is still computed, so the answer
 * takes about as long.
 *
 * POST ORDER: a post from another site is refused first (the
 * cross-site-request rule /auth/confirm uses; this page's own form is always
 * same-origin), then the address is counted, then the link is checked, then
 * the alert is counted, all failing CLOSED. A bad link never gets a bucket
 * of its own. A press that could not finish (the alert could not be marked,
 * or some session did not end) gets a try-again page, and the same link works
 * again: the report signs out every time it runs, and tells people only once.
 */

/** POSTs per address per hour. */
const POSTS_PER_ADDRESS_PER_HOUR = 30;
/** POSTs per alert per hour: a member pressing again, or a retry. */
const POSTS_PER_ALERT_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** An all-zero account id: a tag is still computed when there is no alert, so timing is alike. */
const NO_ACCOUNT = '00000000-0000-4000-8000-000000000000';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The page's own palette (the /auth/confirm and /unsubscribe pages): the
 * app's light ground, card and hairline, one button, and a dark scheme for
 * devices set to dark. A style element in the page itself: no app CSS, font or
 * script loads here (CSP allows inline styles).
 */
const PAGE_STYLE = `
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafaf7;color:#0e0f0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:400px;width:100%;margin:16px;box-sizing:border-box;background:#ffffff;border:1px solid #e7e5dd;border-radius:8px;padding:32px 28px;text-align:center}
.brand{font-weight:600;font-size:15px;letter-spacing:-0.02em;margin-bottom:20px}
h1{font-size:22px;font-weight:500;letter-spacing:-0.02em;line-height:1.25;margin:0 0 10px}
p{color:#5a5d56;font-size:14px;line-height:1.6;margin:0 0 20px}
dl{margin:0 0 20px;padding:12px 14px;background:#f4f3ee;border-radius:6px;text-align:left;font-size:13px;line-height:1.5}
dt{color:#5a5d56;margin:0}
dd{margin:0 0 8px;color:#0e0f0d;font-weight:500}
dd:last-child{margin-bottom:0}
.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:44px;box-sizing:border-box;padding:10px 20px;border:1px solid transparent;border-radius:6px;background:#b42318;color:#ffffff;font:inherit;font-weight:500;font-size:15px;text-decoration:none;cursor:pointer}
.btn:hover{background:#9a1d14}
.btn:focus-visible{outline:2px solid #0e0f0d;outline-offset:2px}
a.link{color:#0e0f0d;font-weight:500;text-underline-offset:2px}
@media (prefers-color-scheme:dark){
body{background:#0c0d0a;color:#f0efe8}
main{background:#131410;border-color:#1f201b}
p,dt{color:#9a9b91}
dl{background:#1c1d18}
dd{color:#f0efe8}
.btn{background:#f2675a;color:#140504}
.btn:hover{background:#f48277}
.btn:focus-visible{outline-color:#f0efe8}
a.link{color:#f0efe8}
}`;

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
      // Never cache a page carrying a signed link or describing its outcome.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      ...extraHeaders,
    },
  });
}

/** The one page for every link that does not check out. */
function badLinkPage(): NextResponse {
  return htmlPage(
    'This link has expired',
    `<p>Open Settings &gt; Security to review your sessions.</p>
    <a class="link" href="/dashboard/settings/security">Go to Settings &gt; Security</a>`,
    400,
  );
}

/** A post from another site: refused before anything is read. Says nothing about the link. */
function refusedPage(): NextResponse {
  return htmlPage(
    'This page cannot be used here',
    `<p>Open the link from your StockPilot email again.</p>`,
    403,
  );
}

function tryAgainPage(): NextResponse {
  return htmlPage(
    'This could not be finished just now',
    `<p>Nothing changed that you need to undo. Wait a minute, then open the link from your email again and press the button once more.</p>`,
    503,
  );
}

function tooManyPage(resetAt: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return htmlPage(
    'Too many tries',
    `<p>Wait a few minutes, then use the link again.</p>`,
    429,
    { 'retry-after': String(retryAfter) },
  );
}

const RESET_BUTTON = `<a class="btn" href="/reset">Reset my password</a>`;

function donePage(): NextResponse {
  return htmlPage(
    'You are signed out on every device.',
    `<p>Reset your password now. Until you do, anyone who knows it can sign in again.</p>
    ${RESET_BUTTON}`,
    200,
  );
}

function alreadyReportedPage(): NextResponse {
  return htmlPage(
    'You already reported this sign-in',
    `<p>Every session of your account was ended then. If you have not reset your password yet, reset it now.</p>
    ${RESET_BUTTON}`,
    200,
  );
}

function whenWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Unknown';
  return at.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
}

/** What the alert was, and the one button. Every value is escaped. */
function confirmPage(alert: SignInAlertRecord, link: { a: string; i: string; t: string }): NextResponse {
  const place = signInAlertPlaceWords(alert.country, alert.city);
  const rows = [
    ['Device', alert.deviceLabel],
    ...(place ? [['Location', `${place} (approximate)`]] : []),
    ['When', whenWords(alert.createdAt)],
    ['Why we asked', signInAlertKindWords({ newDevice: alert.newDevice, newCountry: alert.newCountry })],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');
  return htmlPage(
    'Was this sign-in you?',
    `<dl>${rows}</dl>
    <p>If it was not you, press the button. It signs you out on every device, and the owners and admins of your organization are told.</p>
    <form method="post" action="/sign-in-alert">
      <input type="hidden" name="a" value="${escapeHtml(link.a)}">
      <input type="hidden" name="i" value="${escapeHtml(link.i)}">
      <input type="hidden" name="t" value="${escapeHtml(link.t)}">
      <button type="submit" class="btn">This was not me: sign me out everywhere</button>
    </form>`,
    200,
  );
}

/**
 * The alert a link names, once every check has passed; or the answer to give
 * instead. Shape and window first (no read), then the read, then the tag
 * against the alert's own account.
 */
async function checkedAlert(
  params: { a: string | null; i: string | null; t: string | null },
): Promise<{ alert: SignInAlertRecord; link: { a: string; i: string; t: string } } | NextResponse> {
  const link = readSignInAlertLink(params);
  if (!link) return badLinkPage();
  const now = new Date();
  if (!signInAlertLinkInWindow(link.issuedDay, now)) return badLinkPage();

  const read = await readSignInAlert(link.alertId);
  if (read.kind === 'failed') return tryAgainPage();
  const userId = read.kind === 'found' ? read.alert.userId : NO_ACCOUNT;
  const verdict = verifySignInAlertLink({
    alertId: link.alertId,
    userId,
    issuedDay: link.issuedDay,
    tag: link.tag,
    now,
  });
  if (read.kind !== 'found' || verdict !== 'valid') return badLinkPage();
  return { alert: read.alert, link: { a: link.alertId, i: link.issuedDay, t: link.tag } };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const checked = await checkedAlert({
    a: searchParams.get('a'),
    i: searchParams.get('i'),
    t: searchParams.get('t'),
  });
  if (checked instanceof NextResponse) return checked;
  if (checked.alert.status === 'not_me') return alreadyReportedPage();
  return confirmPage(checked.alert, checked.link);
}

/** A form field as a string; a file or a missing field is null. */
function formString(form: FormData | null, name: string): string | null {
  const value = form?.get(name);
  return typeof value === 'string' ? value : null;
}

export async function POST(request: NextRequest) {
  if (fetchSiteIsElsewhere(request)) return refusedPage();

  // An address that cannot be resolved skips its bucket rather than sharing
  // one counter with every other such caller; the alert's bucket still applies.
  const ip = clientIpFromRequest(request);
  if (ip !== 'unknown') {
    const byAddress = await checkRateLimit(
      `sign-in-alert:ip:${ip}`,
      POSTS_PER_ADDRESS_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    );
    if (!byAddress.allowed) return tooManyPage(byAddress.resetAt);
  }

  const form = await request.formData().catch(() => null);
  const checked = await checkedAlert({
    a: formString(form, 'a'),
    i: formString(form, 'i'),
    t: formString(form, 't'),
  });
  if (checked instanceof NextResponse) return checked;

  const byAlert = await checkRateLimit(
    `sign-in-alert:alert:${checked.alert.id}`,
    POSTS_PER_ALERT_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (!byAlert.allowed) return tooManyPage(byAlert.resetAt);

  const answer = await reportSignInAlertNotMe({
    alert: checked.alert,
    via: 'link',
    request: {
      ip: clientIpForRecord(request.headers),
      userAgent: request.headers.get('user-agent'),
    },
  });
  return answer.outcome === 'done' ? donePage() : tryAgainPage();
}
