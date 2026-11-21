import { NextResponse, type NextRequest } from 'next/server';

import { fetchSiteIsElsewhere } from '@/lib/auth/cross-site-request';
import { readSignInAlertLink, signInAlertLinkInWindow } from '@/lib/auth/sign-in-alert-link';
import { verifySignInAlertLink } from '@/lib/auth/sign-in-alert-url';
import {
  NOT_ME_WORDS,
  signInAlertKindWords,
  signInAlertPlaceWords,
} from '@/lib/auth/sign-in-alert-words';
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
 * GET CHANGES NOTHING about the alert or the account. Mail scanners open
 * every link in an email within seconds of delivery, so GET only shows what
 * the alert was (the member's own words for the device, the place, the time)
 * and one button. It is counted per address (60 an hour) after the link's
 * shape and window check out and BEFORE the alert is read with the service
 * role, so a well-shaped link cannot be used to make reads without end
 * (review 1, finding 9). Over the count it answers "Too many tries" with a
 * 429, the page that names Settings > Security as the other way in. Never
 * "this link has expired": the count needs no valid link, so anyone behind
 * the member's address (a whole school can share one) can spend it, and the
 * member's real link has not expired (review 2, finding 1). The count is
 * taken before the alert is read, so that page says nothing about whether
 * the link is good. POST, from that page's own form, does the report
 * (server/services/sign-in-alert-report.ts): every session of the account is
 * ended, the alert is marked, and the owners and admins are told.
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
 * of its own. A press that could not finish (some session did not end, or
 * the alert could not be marked) gets a try-again page, and the same link
 * works again.
 *
 * ONE ALERT, ONE SIGN-OUT. An alert already reported gets the plain "You
 * already reported this sign-in" page on GET and on POST: no button, no
 * form, and no session is ended again (the report refuses it), so a link
 * sitting in a mailbox cannot be used to end the account's sessions again
 * and again for its seven days. The page says the sessions were ended when
 * it was reported and that the password reset ends them again. POST keeps
 * both counts in front of it. If whoever signed in comes back, the report
 * forgot the device and country rows, so that sign-in raises a new alert
 * with a link of its own.
 *
 * A LIMITER THAT CANNOT COUNT is not "too many tries": the caller did nothing
 * wrong and an hour's wait would be untrue. It answers "Please try again in a
 * moment" (503, no Retry-After) and nothing is read or done.
 *
 * THE WORDS (review 1, findings 1 and 8; NOT_ME_WORDS in
 * lib/auth/sign-in-alert-words.ts) promise what happens and no more: the
 * sessions are ended, a device already open keeps its pass until it expires,
 * the reset closes the door. The done page says the owners and admins were
 * told only when the report says one was; before the press nothing is said
 * about it, because it is not known yet.
 */

/** GETs per address per hour: generous for a person, a bound for a script. */
const VIEWS_PER_ADDRESS_PER_HOUR = 60;
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

/** A limiter could not count: the caller did nothing wrong, and no hour to wait is claimed. */
function busyPage(): NextResponse {
  return htmlPage(
    'Please try again in a moment',
    `<p>We could not check this just now. Nothing changed. Open the link from your email again in a moment.</p>`,
    503,
  );
}

function retryAfterOf(resetAt: number): string {
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

/** Over a count, on GET (views per address) and on POST (presses per address or per alert). */
function tooManyPage(resetAt: number): NextResponse {
  // The counts by address are shared by everyone behind it, and a whole
  // school can share one: name the other way in, which they do not hold.
  return htmlPage(
    'Too many tries',
    `<p>Wait a few minutes, then use the link again. You can also sign in and answer the alert in Settings &gt; Security.</p>
    <a class="link" href="/dashboard/settings/security">Go to Settings &gt; Security</a>`,
    429,
    { 'retry-after': retryAfterOf(resetAt) },
  );
}

const RESET_BUTTON = `<a class="btn" href="/reset">Reset my password</a>`;

/** `adminsTold`: the report told at least one owner or admin; said only then. */
function donePage(adminsTold: boolean): NextResponse {
  return htmlPage(
    NOT_ME_WORDS.sessionsEnded,
    `<p>${NOT_ME_WORDS.openDevice}</p>
    <p>${NOT_ME_WORDS.resetNow}${adminsTold ? ` ${NOT_ME_WORDS.adminsTold}` : ''}</p>
    ${RESET_BUTTON}`,
    200,
  );
}

/** The link's three values, as the page's own form posts them back. Every value is escaped. */
function linkFields(link: { a: string; i: string; t: string }): string {
  return `<input type="hidden" name="a" value="${escapeHtml(link.a)}">
      <input type="hidden" name="i" value="${escapeHtml(link.i)}">
      <input type="hidden" name="t" value="${escapeHtml(link.t)}">`;
}

/**
 * An alert already reported, on GET and on POST: no button and no form (one
 * alert, one sign-out). The reset is how to end the sessions again:
 * completing it ends every session of the account.
 */
function alreadyReportedPage(): NextResponse {
  return htmlPage(
    'You already reported this sign-in',
    `<p>${NOT_ME_WORDS.endedThen}</p>
    <p>${NOT_ME_WORDS.endAgain}</p>
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
    <p>If it was not you, press the button. ${NOT_ME_WORDS.whatItDoes} ${NOT_ME_WORDS.openDevice}</p>
    <p>${NOT_ME_WORDS.thenReset}</p>
    <form method="post" action="/sign-in-alert">
      ${linkFields(link)}
      <button type="submit" class="btn">This was not me: end every session</button>
    </form>`,
    200,
  );
}

/**
 * The alert a link names, once every check has passed; or the answer to give
 * instead. Shape and window first (no read); then `beforeRead`, where GET
 * counts the address; then the read; then the tag against the alert's own
 * account.
 */
async function checkedAlert(
  params: { a: string | null; i: string | null; t: string | null },
  beforeRead?: () => Promise<NextResponse | null>,
): Promise<{ alert: SignInAlertRecord; link: { a: string; i: string; t: string } } | NextResponse> {
  const link = readSignInAlertLink(params);
  if (!link) return badLinkPage();
  const now = new Date();
  if (!signInAlertLinkInWindow(link.issuedDay, now)) return badLinkPage();

  const stopped = beforeRead ? await beforeRead() : null;
  if (stopped) return stopped;

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
  const checked = await checkedAlert(
    {
      a: searchParams.get('a'),
      i: searchParams.get('i'),
      t: searchParams.get('t'),
    },
    async () => {
      // An address that cannot be resolved skips the count rather than
      // sharing one counter with every other such caller (as on POST).
      const ip = clientIpFromRequest(request);
      if (ip === 'unknown') return null;
      const views = await checkRateLimit(
        `sign-in-alert:view:${ip}`,
        VIEWS_PER_ADDRESS_PER_HOUR,
        ONE_HOUR_MS,
        'closed',
      );
      if (views.failed) return busyPage();
      return views.allowed ? null : tooManyPage(views.resetAt);
    },
  );
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
    if (byAddress.failed) return busyPage();
    if (!byAddress.allowed) return tooManyPage(byAddress.resetAt);
  }

  const form = await request.formData().catch(() => null);
  const checked = await checkedAlert({
    a: formString(form, 'a'),
    i: formString(form, 'i'),
    t: formString(form, 't'),
  });
  if (checked instanceof NextResponse) return checked;

  // Counted for every press whose link checks out, a repeat on a reported
  // alert too (the report then ends nothing and answers 'already_reported').
  const byAlert = await checkRateLimit(
    `sign-in-alert:alert:${checked.alert.id}`,
    POSTS_PER_ALERT_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (byAlert.failed) return busyPage();
  if (!byAlert.allowed) return tooManyPage(byAlert.resetAt);

  const answer = await reportSignInAlertNotMe({
    alert: checked.alert,
    via: 'link',
    auditFrom: {
      ip: clientIpForRecord(request.headers),
      userAgent: request.headers.get('user-agent'),
    },
  });
  if (answer.outcome === 'done') return donePage(answer.adminsTold);
  if (answer.outcome === 'already_reported') return alreadyReportedPage();
  return tryAgainPage();
}
