import { NextResponse, type NextRequest } from 'next/server';

import { confirmLanding } from '@/lib/auth/confirm-landing';
import {
  lookUpConfirmRecipient,
  pendingEmailChangeFor,
  verifyConfirmRecipient,
  type ConfirmRecipientAccount,
} from '@/lib/auth/confirm-link';
import { fetchSiteIsElsewhere } from '@/lib/auth/cross-site-request';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import { completeEmailChange, EMAIL_CHANGE_RETURN_PATH } from '@/server/services/email-change';

import {
  PRESS_GATE_FORM_ATTR,
  PRESS_GATE_PASSED_FIELD,
  PRESS_GATE_PASSED_VALUE,
  PRESS_GATE_SCRIPT,
  PRESS_GATE_SEE_ATTR,
} from './press-gate';

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
 *
 * NAVIGATE AND PRESS (docket S14 review, S25). A post from another site is
 * refused (POST below), but nothing stops another site from SENDING the
 * browser here with a link it holds for its own account: this page must render
 * for a click in webmail, which is a cross-site navigation too, and its own
 * form then posts same-origin. So:
 *   - every link carries `r`, the account it is for, signed by our server over
 *     the link's type, token hash and issue time (lib/auth/confirm-link.ts).
 *     GET checks it before anything else and, for a link that checks out,
 *     looks that account up and prints its address above the form; a changed,
 *     moved or relabelled `r` gets the type's refused answer and one past its
 *     hour the expired answer, with no lookup. An email-change link whose
 *     change GoTrue no longer holds (done, cancelled, or replaced by a newer
 *     request) gets the expired answer and no address. POST checks `r` again
 *     before verifyOtp, so the token is not spent;
 *   - a browser already signed in as another account is told both addresses
 *     (and the one already signed in as the link's account is told nothing);
 *     another site can no longer sign the browser out first
 *     (app/auth/session-ended);
 *   - the press counts only after the page has been in front of the person
 *     for a quiet second and every address it names has been on screen
 *     through such a second, wholly or, for one taller than the window, line
 *     by line (./press-gate.ts), so neither a window swap nor a window opened
 *     small, at the button or inside a long address, gets a press before the
 *     account was on screen. No element has an id, so no link can open the
 *     page scrolled to the button;
 *   - the button is disabled in the markup until the gate's script has run,
 *     and POST refuses a press that script did not let through, before
 *     verifyOtp, so nothing can be pressed where the script does not run or
 *     has not arrived yet; the page then says in words that it needs
 *     JavaScript;
 *   - where a link lands is fixed by its type (lib/auth/confirm-landing.ts).
 * A link without `r` gets the type's refused answer, on GET before the
 * session is read or anything is looked up, and on POST before verifyOtp, and
 * is logged with its type only: every link the app writes carries `r`. What
 * stays open: a person who reads another account's address and presses
 * anyway, or is talked into pressing again later (INV-E5, "Not covered").
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

/**
 * A post from another site, refused before verifyOtp. The same pages as a
 * failed link, with a value of its own that they answer with no words
 * (lib/auth/auth-page-notices.ts): the link was neither expired nor used, and
 * the expired-link note, with its advice on getting a new link, would be words
 * the other site chose to put on the card.
 */
function refusedRedirect(origin: string, type: string | null): NextResponse {
  const dest = type === 'recovery' ? '/reset?error=link_refused' : '/signin?error=link_refused';
  return NextResponse.redirect(`${origin}${dest}`, 303);
}

/**
 * The answer for a link whose `r` is missing or did not check out (changed,
 * cut, moved to another link, account or type): the refused answer, which
 * says nothing, as for a post from another site. An email change has its own
 * page.
 */
function refusedAnswer(origin: string, type: string | null): NextResponse {
  return type === 'email_change' ? emailChangeExpiredPage() : refusedRedirect(origin, type);
}

/** The answer for a link that is past its time, or whose account is gone. */
function expiredAnswer(origin: string, type: string | null): NextResponse {
  return type === 'email_change' ? emailChangeExpiredPage() : failureRedirect(origin, type);
}

/** A link type for the logs: one the route sends, or 'other', never a value the request chose. */
function loggedType(type: string | null): string {
  return type && ALLOWED_TYPES.has(type as EmailOtpType) ? type : 'other';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * An email address as the page prints it: escaped, in a face where l, I, 1, O
 * and 0 read apart, and marked for the press gate, which counts a press only
 * once every marked address has been on screen (./press-gate.ts). It stays an
 * inline span: the gate counts an address wrapped taller than the window by
 * its line boxes.
 */
function addr(email: string): string {
  return `<span class="addr" ${PRESS_GATE_SEE_ATTR}>${escapeHtml(email)}</span>`;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // never cache a page carrying a one-time token or describing its outcome
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * The page's own palette (redesign P5.1): the app's light ground, card and
 * hairline, the flat accent button (the old blue-to-indigo gradient predated
 * the brand), and a dark scheme for devices set to dark. It is a style element
 * in the page itself: no app CSS, font or script file loads here (CSP allows
 * inline styles). The address of the account a link is for sits in its own
 * box, in a monospace face that wraps anywhere, and the button is dimmed while
 * it is disabled (the gate's script has not run) and while the press gate has
 * not armed it (S25).
 */
const PAGE_STYLE = `
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafaf7;color:#0e0f0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:400px;width:100%;margin:16px;box-sizing:border-box;background:#ffffff;border:1px solid #e7e5dd;border-radius:8px;padding:32px 28px;text-align:center}
.brand{font-weight:600;font-size:15px;letter-spacing:-0.02em;margin-bottom:20px}
h1{font-size:22px;font-weight:500;letter-spacing:-0.02em;line-height:1.25;margin:0 0 10px}
p{color:#5a5d56;font-size:14px;line-height:1.6;margin:0 0 24px}
p.note,p.needs-script{background:#f9eedc;color:#975d11;border-radius:6px;padding:12px 14px;margin:0 0 20px;text-align:left}
p.recipient{background:#f4f3ee;color:#0e0f0d;border-radius:6px;padding:12px 14px;margin:0 0 16px;text-align:left}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:44px;box-sizing:border-box;padding:10px 20px;border:1px solid transparent;border-radius:6px;background:#2f7463;color:#ffffff;font:inherit;font-weight:500;font-size:15px;text-decoration:none;cursor:pointer}
.btn:hover{background:#28695a}
.btn:focus-visible{outline:2px solid #0e0f0d;outline-offset:2px}
.btn:disabled,.btn[aria-disabled="true"]{opacity:.55;cursor:default}
.btn:disabled:hover,.btn[aria-disabled="true"]:hover{background:#2f7463}
@media (prefers-color-scheme:dark){
body{background:#0c0d0a;color:#f0efe8}
main{background:#131410;border-color:#1f201b}
p{color:#9a9b91}
p.note,p.needs-script{background:#292114;color:#e2b05a}
p.recipient{background:#1c1d18;color:#f0efe8}
.btn{background:#7acdb8;color:#07120e}
.btn:hover{background:#8dd5c2}
.btn:disabled:hover,.btn[aria-disabled="true"]:hover{background:#7acdb8}
.btn:focus-visible{outline-color:#f0efe8}
}`;

function shell(title: string, inner: string): string {
  // Plain server-rendered HTML on purpose: no app bundle loads here, and the
  // token is only ever consumed by the human pressing the button. The form
  // page's one script is the press gate: the button is disabled in the
  // markup until that script has run, and a client without scripts reads the
  // noscript line instead.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · StockPilot</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <div class="brand">StockPilot</div>
    ${inner}
  </main>
</body></html>`;
}

function statusPage(args: {
  title: string;
  heading: string;
  body: string;
  linkLabel?: string;
  linkHref?: string;
  status?: number;
}) {
  const link =
    args.linkLabel && args.linkHref
      ? `<a href="${escapeHtml(args.linkHref)}" class="btn">${escapeHtml(args.linkLabel)}</a>`
      : '';
  const html = shell(
    args.title,
    `<h1>${escapeHtml(args.heading)}</h1>
    <p>${escapeHtml(args.body)}</p>
    ${link}`,
  );
  return new NextResponse(html, { status: args.status ?? 200, headers: PAGE_HEADERS });
}

/** An email-change link that cannot be used: nothing about the account changed. */
function emailChangeExpiredPage(): NextResponse {
  return statusPage({
    title: 'Link expired',
    heading: 'This link has expired or was already used',
    body: 'Nothing about your account has changed. Open Settings → Profile to send a fresh verification.',
    linkLabel: 'Go to Settings → Profile',
    linkHref: EMAIL_CHANGE_RETURN_PATH,
  });
}

/**
 * The account a signed link is for could not be looked up (GoTrue failed, or
 * took past five seconds). No form: the press is offered only with the
 * account's address on the page. Nothing was spent, so the same link works
 * once GoTrue answers.
 */
function tryAgainPage(): NextResponse {
  return statusPage({
    title: 'Try again',
    heading: 'This link could not be opened just now',
    body: 'Nothing was used and nothing changed. Wait a minute, then open the link from your email again.',
    status: 503,
  });
}

/**
 * The press signed this browser in to an account other than the one the link
 * named (a bug of ours: a builder signed the wrong id). The session was just
 * ended, so the page claims nothing about any account.
 */
function otherAccountSignedOutPage(): NextResponse {
  return statusPage({
    title: 'Sign in to continue',
    heading: 'Sign in to continue',
    body: 'This link could not be completed in this browser. Sign in to StockPilot to continue.',
    linkLabel: 'Go to sign in',
    linkHref: '/signin',
  });
}

/**
 * Where a verified link of this type lands: email_change has its own fixed
 * page, every other type the landing lib/auth/confirm-landing.ts keeps for it
 * (`next` only when it is one of them, exactly).
 */
function landingFor(type: string, next: string | null): string {
  return type === 'email_change' ? EMAIL_CHANGE_RETURN_PATH : confirmLanding(type, next);
}

/**
 * The account this browser is signed in as, when GoTrue answers with one. Null
 * when it is signed out (an email scanner's prefetch carries no cookie, so this
 * costs it no round trip) or the check fails; the page then renders as before.
 */
async function signedInAccount(): Promise<{ id: string; email: string | null } | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { id: user.id, email: user.email ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * The one line naming the account a signed link is for (S25): its full
 * address, looked up on the server, so a lookalike cannot hide behind a mask.
 * Fixed words per type; only the escaped address varies.
 */
function recipientLine(type: 'recovery' | 'invite' | 'magiclink', email: string): string {
  const notYours = 'If that is not your email address, close this page.';
  switch (type) {
    case 'recovery':
      return `This link sets a new password for ${addr(email)}. ${notYours}`;
    case 'invite':
      return `This invite is for ${addr(email)}. ${notYours}`;
    case 'magiclink':
      return `This link signs in as ${addr(email)}. ${notYours}`;
  }
}

/**
 * The line for an email-change link: the account's address and the one still
 * waiting to replace it. GET shows it only while GoTrue holds the change the
 * link was sent for (pendingEmailChangeFor).
 */
function emailChangeLine(current: string, pending: string): string {
  return `This link changes the sign-in email of ${addr(current)} to ${addr(pending)}. If neither address is yours, close this page.`;
}

/**
 * A signed link in a browser signed in as ANOTHER account (compared by user
 * id, never by address): pressing on replaces that session, and the page
 * names both. A browser already signed in as the link's own account is told
 * nothing: there is nothing to warn about.
 */
function otherAccountNotice(signedInEmail: string | null, recipientEmail: string): string {
  const who = signedInEmail
    ? `You're signed in as ${addr(signedInEmail)} on this browser.`
    : 'This browser is already signed in to another StockPilot account.';
  return `<p class="note">${who} Continuing signs you in as ${addr(recipientEmail)} instead. If you didn't ask for this link, close this page.</p>`;
}

/** What a browser that runs no script shows above the disabled button. */
const NO_SCRIPT_LINE =
  'This page needs JavaScript to continue. Turn JavaScript on for this site, or open the link from your email in another browser.';

/**
 * The click-through page: the lines above the form (the account the link is
 * for, and any notice), the form, which carries `r` back to POST, and the
 * press gate after it. The button is disabled here and enabled only by the
 * gate's script, so it cannot be pressed where that script does not run, or
 * before the end of it has arrived; a browser with scripts off shows
 * NO_SCRIPT_LINE instead. Every value from the request is
 * escaped, and each was checked first (the type against ALLOWED_TYPES, next
 * against the type's landings, the token hash and `r` by their shapes and
 * `r`'s signature), so nothing from the URL can add markup or reach the script.
 */
function confirmPage(args: {
  type: string;
  tokenHash: string;
  next: string;
  r: string;
  lines: string;
}): NextResponse {
  const { type } = args;
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
    `<h1>${heading}</h1>
    ${args.lines}
    <p>
      This link works once. Press the button to continue.
    </p>
    <noscript><p class="needs-script">${NO_SCRIPT_LINE}</p></noscript>
    <form method="post" action="/auth/confirm" ${PRESS_GATE_FORM_ATTR}>
      <input type="hidden" name="token_hash" value="${escapeHtml(args.tokenHash)}">
      <input type="hidden" name="type" value="${escapeHtml(type)}">
      <input type="hidden" name="next" value="${escapeHtml(args.next)}">
      <input type="hidden" name="r" value="${escapeHtml(args.r)}">
      <button type="submit" class="btn" disabled>
        ${button}
      </button>
    </form>
    <script>${PRESS_GATE_SCRIPT}</script>`,
  );
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type as EmailOtpType)) {
    return failureRedirect(origin, type);
  }
  const next = landingFor(type, searchParams.get('next'));
  const r = searchParams.get('r');

  if (r === null) {
    // Every link the app writes carries r (lib/auth/confirm-link.ts). One
    // without it names no account, so it gets the refused answer before
    // anything is read: no session read, no lookup, no form. Logged with the
    // type only.
    console.info('[auth/confirm] link without a recipient', { type });
    return refusedAnswer(origin, type);
  }

  // Checked before anything is read: a link r does not vouch for costs no
  // session read and no lookup, and says nothing about any account.
  const verdict = verifyConfirmRecipient({ type, tokenHash, r });
  if (verdict.status === 'invalid') return refusedAnswer(origin, type);
  if (verdict.status === 'stale') return expiredAnswer(origin, type);

  const [signedIn, account]: [
    { id: string; email: string | null } | null,
    ConfirmRecipientAccount,
  ] = await Promise.all([signedInAccount(), lookUpConfirmRecipient(verdict.userId)]);
  // Deleted, disabled or without an address: the link cannot be used.
  if (account.kind === 'gone') return expiredAnswer(origin, type);
  if (account.kind === 'failed') {
    // Fail closed: never the form without the address. Reported with the
    // type only (never the id, the token or r).
    void reportError(
      new Error(
        account.reason === 'timeout'
          ? 'the confirmation link recipient lookup took too long'
          : 'the confirmation link recipient lookup failed',
      ),
      { tag: 'auth.confirm_recipient_lookup_failed', level: 'warning', extra: { type } },
    );
    return tryAgainPage();
  }
  let line: string;
  if (type === 'email_change') {
    // GoTrue keeps one pending change, and every new request replaces the
    // links of the last one. A link whose change is done, cancelled or
    // replaced gets the expired answer and no address: the account's
    // addresses now are not the ones it was sent for (a link sent to a
    // mistyped address must not show the corrected one).
    const pending = pendingEmailChangeFor(account, verdict.issued);
    if (pending === null) return expiredAnswer(origin, type);
    line = emailChangeLine(account.email, pending);
  } else {
    line = recipientLine(type as 'recovery' | 'invite' | 'magiclink', account.email);
  }
  const notice =
    signedIn && signedIn.id !== verdict.userId
      ? otherAccountNotice(signedIn.email, account.email)
      : '';
  return confirmPage({
    type,
    tokenHash,
    next,
    r,
    lines: `<p class="recipient">${line}</p>
    ${notice}`,
  });
}

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const tokenHash = (form?.get('token_hash') as string | null) ?? null;
  const type = (form?.get('type') as string | null) ?? null;
  const next = (form?.get('next') as string | null) ?? null;
  const r = (form?.get('r') as string | null) ?? null;

  // A post from another site (login CSRF, docket S14). The token in the form is
  // the credential and this answer SETS the session cookie, so a page on another
  // site posting a token it holds (its own account's recovery link) would sign
  // this browser into that account. The page GET renders posts to itself, so
  // its form is always same-origin; its Origin is `null` by the page's own
  // no-referrer policy, so only Sec-Fetch-Site can say where a post came from
  // (lib/auth/cross-site-request.ts). Refused before verifyOtp, so the token is
  // not spent, to the page an unusable link of its type lands on, which says
  // nothing for it (refusedRedirect).
  if (fetchSiteIsElsewhere(request)) {
    return type === 'email_change' ? emailChangeExpiredPage() : refusedRedirect(origin, type);
  }

  // The press gate's field (S25): the page's script adds it to the form when
  // it lets a press through, so a post without it did not come through the
  // gate. Refused before r is read and before verifyOtp, so the token is not
  // spent and the same link still works from a page whose script has run.
  // Logged with the link type only.
  if (form?.get(PRESS_GATE_PASSED_FIELD) !== PRESS_GATE_PASSED_VALUE) {
    console.info('[auth/confirm] confirmation posted without the press gate field', {
      type: loggedType(type),
    });
    return refusedAnswer(origin, type);
  }

  // A post with NO Sec-Fetch-Site is verified, unlike an API write (decided
  // 2026-10-24, docket S14). Its Origin is `null` by this page's own policy, so
  // without Sec-Fetch-Site no header can tell this page's post from another
  // site's, and refusing it would refuse every browser that does not send
  // Fetch Metadata (Safari before 16.4, Firefox before 90, Chrome before 76),
  // and an emailed link opens on whatever device holds the email (the page's
  // one script is plain ES5 with no dependency). Every browser the app
  // supports sends Sec-Fetch-Site over https, and so does Safari on every
  // phone that runs the app (iOS 16.4 and later), so the cross-site refusal
  // above covers them. Logged with the link type only, so the runtime logs
  // show whether a real browser ever posts without it before anyone tightens
  // this.
  if (!request.headers.has('sec-fetch-site')) {
    console.info('[auth/confirm] confirmation posted without Sec-Fetch-Site', {
      type: loggedType(type),
    });
  }

  // The account the link names (S25), checked again before the token is
  // spent: the page's form carries r back, and a post can carry any r, or
  // none. A post without r is refused (see GET), a changed one is refused and
  // one past its hour expired, as on GET.
  if (r === null) {
    console.info('[auth/confirm] link without a recipient', { type: loggedType(type) });
    return refusedAnswer(origin, type);
  }
  const verdict = verifyConfirmRecipient({ type: type ?? '', tokenHash: tokenHash ?? '', r });
  if (verdict.status === 'invalid') return refusedAnswer(origin, type);
  if (verdict.status === 'stale') return expiredAnswer(origin, type);
  const recipient = verdict.userId;

  if (tokenHash && type && ALLOWED_TYPES.has(type as EmailOtpType)) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });

    // GoTrue made a session for an account other than the one r names: a
    // builder of ours signed the wrong id (none is known). The browser must
    // not stay in an account the page did not name.
    const sessionUserId = data?.session?.user?.id ?? null;
    if (sessionUserId !== null && sessionUserId !== recipient) {
      if (type === 'email_change') {
        // GoTrue has already applied the change, to the session's account:
        // repair its profile and tell its old address, as for any change.
        try {
          await completeEmailChange({ userId: sessionUserId });
        } catch (e) {
          void reportError(e, { tag: 'auth.email_change_complete_failed', level: 'warning' });
        }
      }
      // This session only: clears the cookies verifyOtp just set, in this
      // same answer.
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        // The page below claims nothing either way.
      }
      void reportError(
        new Error('a confirmation link made a session for another account than its r names'),
        {
          tag: 'auth.confirm_recipient_mismatch',
          level: 'error',
          extra: { type },
        },
      );
      return otherAccountSignedOutPage();
    }

    if (type === 'email_change') {
      if (error) return emailChangeExpiredPage();
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
      return NextResponse.redirect(`${origin}${landingFor(type, next)}`, 303);
    }
  }

  return failureRedirect(origin, type);
}
