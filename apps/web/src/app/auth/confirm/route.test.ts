// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

// /auth/confirm is the endpoint for auth-email links (password reset,
// platform invites). Contract pinned here:
//   1. GET must NEVER consume the one-time token — email security
//      scanners prefetch links within seconds of delivery (observed in
//      prod: a recovery token eaten by a GET 28s after send). GET renders
//      a click-through form; only POST verifies.
//   2. POST verifies via auth.verifyOtp and redirects to the link type's
//      landing (`next` only when it is one of the type's landings, see
//      lib/auth/confirm-landing.ts); failures land recovery users on
//      /reset?error=link_expired.
//   3. (docket S25) A link carries `r`, the account it is for, signed by our
//      server: the page names that account before anyone presses, and a link
//      whose `r` was changed, moved to another link or type, or is past its
//      hour is refused on GET and POST before the token is spent.
//   4. (docket S25) The page's button is disabled in the markup and enabled
//      only by the page's one script, the press gate, which adds a field to
//      the form when it lets a press through. POST refuses a post without
//      that field before the token is spent, and a browser that runs no
//      script reads in words that the page needs JavaScript.

// The service key the signing key is derived from: a dull value under a
// neutral name (src/test/secret-shaped-fixtures.guard.test.ts), set before
// @/lib/env reads the environment.
const SIGNING_INPUT = vi.hoisted(() => {
  const value = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = value;
  return value;
});

const verifyOtp = vi.fn();
const signOut = vi.fn(async (_args?: { scope?: string }) => ({ error: null }));
// The browser's current session, read by GET (the signed-in notice). Signed
// out unless a test says otherwise.
const getUser = vi.fn(async () => ({
  data: { user: null as { id: string; email?: string | null } | null },
  error: null,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp, getUser, signOut } }),
}));
// GoTrue's admin lookup of the account a link is for: the only network call
// the recipient check makes (lib/auth/confirm-link.ts runs for real).
const getUserById = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById } } }),
}));
const completeEmailChange = vi.fn(async (_args: { userId: string }) => ({
  email: 'new@example.com',
  notifiedPreviousEmail: 'old@example.com',
}));
vi.mock('@/server/services/email-change', () => ({
  completeEmailChange: (args: { userId: string }) => completeEmailChange(args),
  EMAIL_CHANGE_RETURN_PATH: '/dashboard/settings/profile',
}));
const reportError = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { EMAIL_CHANGE_REQUEST_SKEW_S } from '@/lib/auth/confirm-link';
import { signConfirmRecipient } from '@/lib/auth/confirm-recipient';

import {
  PRESS_GATE_FORM_ATTR,
  PRESS_GATE_PASSED_FIELD,
  PRESS_GATE_PASSED_VALUE,
  PRESS_GATE_SCRIPT,
  PRESS_GATE_SEE_ATTR,
} from './press-gate';
import { GET, POST } from './route';

const BASE = 'https://app.example.com';

// The account a link is for, and another one a browser can be signed in as.
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const EMAIL_A = 'person@example.com';
const EMAIL_B = 'member@example.com';
/** GoTrue's hashed tokens are sha224 in hex: 56 characters. */
const HASH_A = 'ab'.repeat(28);
const HASH_B = 'cd'.repeat(28);

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** `r` as our link builders sign it (lib/auth/confirm-link.ts), for this test's key. */
function signedRef(args: {
  type: string;
  tokenHash: string;
  userId: string;
  issued?: number;
}): string {
  const r = signConfirmRecipient(SIGNING_INPUT, { ...args, issued: args.issued ?? nowSeconds() });
  if (!r) throw new Error('the test could not sign r');
  return r;
}

function linkQuery(args: {
  type: string;
  tokenHash?: string;
  userId?: string;
  next?: string;
  r?: string;
}): string {
  const tokenHash = args.tokenHash ?? HASH_A;
  const q = new URLSearchParams({ token_hash: tokenHash, type: args.type });
  if (args.next !== undefined) q.set('next', args.next);
  q.set('r', args.r ?? signedRef({ type: args.type, tokenHash, userId: args.userId ?? USER_A }));
  return q.toString();
}

function getReq(qs: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE}/auth/confirm?${qs}`, { headers });
}

/** A post with exactly these fields: whatever sent it, the press gate did not let it through. */
function postWithoutGate(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  const form = new URLSearchParams(fields);
  return new NextRequest(`${BASE}/auth/confirm`, {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}

/**
 * A press as the page's own form sends it: the press gate let it through, so
 * it carries the field the gate's script adds (press-gate.test.ts holds the
 * script to adding it on such a press only).
 */
function postReq(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  return postWithoutGate(
    { ...fields, [PRESS_GATE_PASSED_FIELD]: PRESS_GATE_PASSED_VALUE },
    headers,
  );
}

/** The account GoTrue holds for an id. */
function account(email: string | null, more: Record<string, unknown> = {}) {
  return { data: { user: { id: USER_A, email, ...more } }, error: null };
}

function signedInAs(id: string, email: string | null) {
  getUser.mockResolvedValueOnce({ data: { user: { id, email } }, error: null });
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', origin: 'null' };

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockReset();
  getUserById.mockResolvedValue(account(EMAIL_A));
});

describe('GET /auth/confirm', () => {
  it('renders the click-through page WITHOUT consuming the token', async () => {
    const res = await GET(getReq('token_hash=abc123&type=recovery&next=%2Freset%2Fcomplete'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('form method="post"');
    expect(html).toContain('abc123');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('redirects invalid types to signin without rendering a form', async () => {
    // 'magiclink' used to be the invalid-type example here, but dd83437c
    // (2026-07-09, B2B portal adversarial review) added it to ALLOWED_TYPES
    // as the existing-user re-invite fallback — it now legitimately renders
    // the click-through form (see the test above). Use a type this route
    // genuinely never allowlists instead.
    // 'email_change' joined the allowlist on 2026-08-25 (verified email
    // change, mig 0345); 'signup' is a real EmailOtpType this route never
    // sends and never accepts.
    const res = await GET(getReq('token_hash=abc&type=signup&next=%2Fdashboard'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/signin?error=auth_callback_failed`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('redirects a missing token to the reset form for recovery type', async () => {
    const res = await GET(getReq('type=recovery'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
  });
});

describe('POST /auth/confirm', () => {
  it('verifies the token and redirects to the sanitized next path', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq({ token_hash: 'abc123', type: 'recovery', next: '/reset/complete' }),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc123' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
  });

  it('sends expired/used recovery tokens to /reset with the notice param', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });
    const res = await POST(postReq({ token_hash: 'stale', type: 'recovery', next: '/reset/complete' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
  });

  it('neutralizes protocol-relative next paths (the link type decides where it lands)', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(postReq({ token_hash: 'abc', type: 'recovery', next: '//evil.com' }));
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
  });

  it('rejects disallowed types without calling verifyOtp', async () => {
    const res = await POST(postReq({ token_hash: 'abc', type: 'signup', next: '/x' }));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A POST FROM ANOTHER SITE (login CSRF, docket S14). The token in the form is
// the credential and the answer SETS the session cookie, so a page on another
// site posting a token it holds (its own account's recovery link) would sign
// this browser into that account. The page this route renders posts to
// itself, so its form is always same-origin. Its Origin is `null` (the page's
// own no-referrer policy), so only Sec-Fetch-Site can say where a post came
// from; a browser without it is judged as before.
// ─────────────────────────────────────────────────────────────────────────
describe('POST /auth/confirm from another site', () => {
  // The refusal has its own value, which the page answers with no words
  // (lib/auth/auth-page-notices.ts, docket B39 review): the link was neither
  // expired nor used, and the expired-link note, with its advice on getting a
  // new link, would be words the other site chose to put on the card.
  it.each(['cross-site', 'same-site', 'none'])(
    'Sec-Fetch-Site %s: the refused answer, never the expired one, and the token is not spent',
    async (site) => {
      verifyOtp.mockResolvedValue({ error: null });
      const res = await POST(
        postReq(
          { token_hash: 'held-by-another-page', type: 'recovery', next: '/reset/complete' },
          { 'sec-fetch-site': site, origin: 'https://evil.example' },
        ),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_refused`);
      expect(verifyOtp).not.toHaveBeenCalled();
    },
  );

  it('an invite or a sign-in link from another site: the refused /signin bounce, never a session', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    for (const type of ['invite', 'magiclink']) {
      const res = await POST(
        postReq(
          { token_hash: 'held', type, next: '/dashboard' },
          { 'sec-fetch-site': 'cross-site' },
        ),
      );
      expect(res.status, type).toBe(303);
      expect(res.headers.get('location'), type).toBe(`${BASE}/signin?error=link_refused`);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('an unknown or missing type from another site: the refused /signin bounce', async () => {
    const forms: Record<string, string>[] = [
      { token_hash: 'held', type: 'signup' },
      { token_hash: 'held' },
    ];
    for (const fields of forms) {
      const res = await POST(postReq(fields, { 'sec-fetch-site': 'cross-site' }));
      expect(res.headers.get('location')).toBe(`${BASE}/signin?error=link_refused`);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('an email change from another site: its own expired page, and nothing changes', async () => {
    const res = await POST(
      postReq({ token_hash: 'side-b', type: 'email_change' }, { 'sec-fetch-site': 'same-site' }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Nothing about your account has changed');
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('a post from another site carrying a valid r is still refused before anything else', async () => {
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'magiclink',
          next: '/dashboard',
          r: signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A }),
        },
        { 'sec-fetch-site': 'cross-site' },
      ),
    );
    expect(res.headers.get('location')).toBe(`${BASE}/signin?error=link_refused`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("this route's own page (same-origin, Origin null by its no-referrer policy): verified as before", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq(
        { token_hash: 'abc123', type: 'recovery', next: '/reset/complete' },
        { 'sec-fetch-site': 'same-origin', origin: 'null' },
      ),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc123' });
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
  });

  // Decided 2026-10-24 (the integrator asked, docket S14): unlike an API write,
  // a confirmation with no Sec-Fetch-Site is NOT refused. Its Origin is `null`
  // by this page's own policy, so without Sec-Fetch-Site no header tells this
  // page's post from another site's, and refusing would refuse every browser
  // without Fetch Metadata, on a page that loads no script and that the email
  // opens on whatever device holds it. It is logged instead, type only.
  it('a browser that sends no Sec-Fetch-Site: verified as before, and logged without the token', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A });
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
    const res = await POST(
      postReq(
        { token_hash: HASH_A, type: 'recovery', next: '/reset/complete', r },
        { origin: 'null' },
      ),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toEqual({ type: 'recovery' });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(HASH_A);
    expect(logged).not.toContain(r);
    expect(logged).not.toContain('/reset/complete');
    info.mockRestore();
  });

  it('the log names only a known link type, never a value the form chose', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await POST(postReq({ token_hash: 'abc123', type: 'x'.repeat(5000) }));
    expect(info.mock.calls[0]![1]).toEqual({ type: 'other' });
    for (const call of info.mock.calls) expect(call[1]).toEqual({ type: 'other' });
    info.mockRestore();
  });

  it("this route's own page with Sec-Fetch-Site same-origin, carrying its r, is not logged", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
    await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'recovery',
          next: '/reset/complete',
          r: signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NAVIGATE AND PRESS (docket S14 review, closed by S25). Refusing a post from
// another site does not stop another site from SENDING the browser to this
// page with a link it holds for its own account: the page must render for a
// click in webmail, which is a cross-site navigation too, and its form then
// posts from the app's own page (same-origin). S14 named the account the
// browser is already signed in as and fixed where each type lands; S25 names
// the account the LINK is for, from `r`, which only our server can sign.
// ─────────────────────────────────────────────────────────────────────────
describe('GET /auth/confirm names the account the link is for (S25)', () => {
  it("the S25 case: a signed-out browser sent cross-site to another account's sign-in link sees that account's address above the form, and nothing is spent", async () => {
    const qs = linkQuery({ type: 'magiclink', next: '/dashboard' });
    const res = await GET(
      getReq(qs, {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(
      'This link signs in as <span class="addr" data-press-gate-see>person@example.com</span>. If that is not your email address, close this page.',
    );
    // The line comes before the form.
    expect(html.indexOf('This link signs in as')).toBeLessThan(html.indexOf('<form'));
    // The form carries r, so the press is checked against the same account.
    const r = new URLSearchParams(qs).get('r')!;
    expect(html).toContain(`<input type="hidden" name="r" value="${r}">`);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledWith(USER_A);
    expect(verifyOtp).not.toHaveBeenCalled();
    // Signed out: no signed-in notice.
    expect(html).not.toContain('class="note"');
  });

  it.each([
    [
      'recovery',
      'This link sets a new password for <span class="addr" data-press-gate-see>person@example.com</span>. If that is not your email address, close this page.',
      'Reset your password',
    ],
    [
      'invite',
      'This invite is for <span class="addr" data-press-gate-see>person@example.com</span>. If that is not your email address, close this page.',
      'Accept your invite',
    ],
    [
      'magiclink',
      'This link signs in as <span class="addr" data-press-gate-see>person@example.com</span>. If that is not your email address, close this page.',
      'Sign in',
    ],
  ])('%s: one fixed line naming the account', async (type, line, heading) => {
    const html = await (await GET(getReq(linkQuery({ type })))).text();
    expect(html).toContain(line);
    expect(html).toContain(`<h1>${heading}</h1>`);
  });

  it('an email change names the current address and the one waiting to replace it', async () => {
    getUserById.mockResolvedValueOnce(account('old@example.com', { new_email: 'new@example.com' }));
    const html = await (await GET(getReq(linkQuery({ type: 'email_change' })))).text();
    expect(html).toContain(
      'This link changes the sign-in email of <span class="addr" data-press-gate-see>old@example.com</span> to <span class="addr" data-press-gate-see>new@example.com</span>. If neither address is yours, close this page.',
    );
    expect(html).toContain('Confirm your email change');
  });

  it('an email change with nothing waiting (the change finished or was cancelled): the expired page, with no address and no form', async () => {
    getUserById.mockResolvedValueOnce(account('new@example.com', { new_email: '' }));
    const res = await GET(getReq(linkQuery({ type: 'email_change' })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('This link has expired or was already used');
    expect(html).not.toContain('new@example.com');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
    expect(reportError).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('an email change a newer request replaced: the expired page with neither address, so a link sent to a mistyped address never shows the corrected one', async () => {
    const issued = nowSeconds() - 600;
    const r = signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A, issued });
    // The person corrected the change a minute later: GoTrue now holds the
    // corrected address and that request's time, and this link is dead.
    getUserById.mockResolvedValueOnce(
      account('old@example.com', {
        new_email: 'corrected@example.com',
        email_change_sent_at: new Date((issued + 60) * 1000).toISOString(),
      }),
    );
    const res = await GET(getReq(linkQuery({ type: 'email_change', r })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('This link has expired or was already used');
    expect(html).not.toContain('corrected@example.com');
    expect(html).not.toContain('old@example.com');
    expect(html).not.toContain('<form');
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an email change whose request GoTrue timed up to EMAIL_CHANGE_REQUEST_SKEW_S after the link's issue time is the link's own request: both addresses", async () => {
    const issued = nowSeconds() - 600;
    const r = signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A, issued });
    const line =
      /This link changes the sign-in email of <span class="addr"[^>]*>old@example\.com<\/span> to <span class="addr"[^>]*>new@example\.com<\/span>\./;
    // GoTrue writes the request time before the link is signed: earlier, or
    // later only by the clocks and the issue time's whole seconds.
    for (const offset of [-2, 0.75, EMAIL_CHANGE_REQUEST_SKEW_S]) {
      getUserById.mockResolvedValueOnce(
        account('old@example.com', {
          new_email: 'new@example.com',
          email_change_sent_at: new Date((issued + offset) * 1000).toISOString(),
        }),
      );
      const html = await (await GET(getReq(linkQuery({ type: 'email_change', r })))).text();
      expect(html, String(offset)).toMatch(line);
      expect(html, String(offset)).toContain('form method="post"');
    }
    // A request any later than that is a newer one.
    getUserById.mockResolvedValueOnce(
      account('old@example.com', {
        new_email: 'new@example.com',
        email_change_sent_at: new Date(
          (issued + EMAIL_CHANGE_REQUEST_SKEW_S + 1) * 1000,
        ).toISOString(),
      }),
    );
    const html = await (await GET(getReq(linkQuery({ type: 'email_change', r })))).text();
    expect(html).toContain('This link has expired or was already used');
    expect(html).not.toContain('new@example.com');
  });

  it('escapes the address it prints', async () => {
    getUserById.mockResolvedValueOnce(account('a<b>"c\'d&@example.com'));
    const html = await (await GET(getReq(linkQuery({ type: 'recovery' })))).text();
    expect(html).toContain(
      '<span class="addr" data-press-gate-see>a&lt;b&gt;&quot;c&#39;d&amp;@example.com</span>',
    );
    expect(html).not.toContain('a<b>');
  });

  it('carries exactly one script, the press gate, inline, after a form whose one button is disabled in the markup', async () => {
    const html = await (
      await GET(getReq(linkQuery({ type: 'magiclink', next: '/dashboard' })))
    ).text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toBe('');
    expect(scripts[0]![2]).toBe(PRESS_GATE_SCRIPT);
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    // The gate comes after the form it guards.
    expect(html.indexOf('<script>')).toBeGreaterThan(html.indexOf('</form>'));
    expect(html).toContain('<form method="post" action="/auth/confirm" data-press-gate>');
    // The page's only button, and only way to post, is disabled as sent: the
    // gate's script is what enables it (press-gate.test.ts).
    expect(html.match(/<button\b[^>]*>/gi)).toEqual([
      '<button type="submit" class="btn" disabled>',
    ]);
    expect(html).not.toMatch(/<input\b[^>]*type="(?:submit|image)"/i);
    expect(html).not.toMatch(/\bformaction\b/i);
    // The field POST asks for is not in the markup either: only the gate's
    // script names it, and adds it.
    const beforeScript = html.slice(0, html.indexOf('<script>'));
    expect(beforeScript).not.toContain(PRESS_GATE_PASSED_FIELD);
    expect(PRESS_GATE_SCRIPT).toContain(`'${PRESS_GATE_PASSED_FIELD}'`);
  });

  it('tells a browser that runs no script, in words above the disabled button, that the page needs JavaScript', async () => {
    const NO_SCRIPT =
      '<noscript><p class="needs-script">This page needs JavaScript to continue. Turn JavaScript on for this site, or open the link from your email in another browser.</p></noscript>';
    for (const qs of [
      linkQuery({ type: 'recovery' }),
      linkQuery({ type: 'invite' }),
      linkQuery({ type: 'magiclink' }),
    ]) {
      const html = await (await GET(getReq(qs))).text();
      expect(html.match(/<noscript\b/gi), qs).toHaveLength(1);
      expect(html, qs).toContain(NO_SCRIPT);
      expect(html.indexOf(NO_SCRIPT), qs).toBeLessThan(html.indexOf('<form'));
      expect(html, qs).toContain('<button type="submit" class="btn" disabled>');
    }
    getUserById.mockResolvedValueOnce(
      account('old@example.com', {
        new_email: 'new@example.com',
        email_change_sent_at: new Date().toISOString(),
      }),
    );
    const change = await (await GET(getReq(linkQuery({ type: 'email_change' })))).text();
    expect(change).toContain(NO_SCRIPT);
    expect(change).toContain('<button type="submit" class="btn" disabled>');
  });

  // Three headers the app's header rules send to this path stand behind the
  // gate as a second line: the opener policy and the two that refuse a frame
  // (src/test/security-headers.test.ts). A header of the page's own would
  // replace or double the rule's value, so the page sets none of them.
  it('sets no opener policy or framing header of its own: the header rules of the app send them', async () => {
    const res = await GET(getReq(linkQuery({ type: 'magiclink', next: '/dashboard' })));
    expect(res.status).toBe(200);
    for (const name of [
      'cross-origin-opener-policy',
      'x-frame-options',
      'content-security-policy',
    ]) {
      expect(res.headers.get(name), name).toBeNull();
    }
  });

  it('gives no element an id a link could scroll to, and marks every address it names for the gate (S25 review)', async () => {
    // Signed in as another account: the line names the link's account, and
    // the note names both.
    signedInAs(USER_B, EMAIL_B);
    const html = await (
      await GET(getReq(linkQuery({ type: 'magiclink', next: '/dashboard' })))
    ).text();
    // A fragment scrolls only to an element with that id (or an <a name>),
    // so with none, no link can open the page at the button with the
    // account's line above the window (an old link's #confirm-form did, in
    // every engine).
    expect(html).not.toMatch(/\sid\s*=/i);
    expect(html).not.toMatch(/<a\b[^>]*\bname\s*=/i);
    expect(html).not.toContain('confirm-form');
    // The gate finds its form, and the addresses it waits on, by attribute.
    expect(PRESS_GATE_FORM_ATTR).toBe('data-press-gate');
    expect(PRESS_GATE_SEE_ATTR).toBe('data-press-gate-see');
    expect(html.match(/<form\b[^>]*>/gi)).toEqual([
      `<form method="post" action="/auth/confirm" ${PRESS_GATE_FORM_ATTR}>`,
    ]);
    const marked = [
      ...html.matchAll(/<span class="addr" data-press-gate-see>([^<]*)<\/span>/g),
    ].map((m) => m[1]);
    expect(marked).toEqual([EMAIL_A, EMAIL_B, EMAIL_A]);
    expect(html.match(/<span\b[^>]*>/g)).toHaveLength(3);
    // Each mark comes before the form (the gate's own script names the
    // attribute too, after the form).
    const page = html.slice(0, html.indexOf('<script>'));
    expect(page.lastIndexOf(PRESS_GATE_SEE_ATTR)).toBeLessThan(page.indexOf('<form'));
  });

  it('nothing taken from the URL reaches the page unchecked: a hostile next or extra parameter changes nothing', async () => {
    const qs = `${linkQuery({ type: 'magiclink', next: '/dashboard' })}&next=%3C%2Fscript%3E&x=%3Cscript%3E`;
    const html = await (await GET(getReq(qs))).text();
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html).not.toContain('</script></script>');
    expect(html).toContain('<input type="hidden" name="next" value="/dashboard">');
  });
});

describe('GET /auth/confirm with an r that does not check out (S25)', () => {
  it.each([
    [
      'signed for another token',
      () =>
        linkQuery({
          type: 'magiclink',
          r: signedRef({ type: 'magiclink', tokenHash: HASH_B, userId: USER_A }),
        }),
      '/signin?error=link_refused',
    ],
    [
      'a recovery link relabelled as a sign-in link',
      () =>
        linkQuery({
          type: 'magiclink',
          r: signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }),
        }),
      '/signin?error=link_refused',
    ],
    [
      'an invite relabelled as a reset',
      () =>
        linkQuery({
          type: 'recovery',
          r: signedRef({ type: 'invite', tokenHash: HASH_A, userId: USER_A }),
        }),
      '/reset?error=link_refused',
    ],
    [
      'moved to another account',
      () =>
        linkQuery({
          type: 'recovery',
          r: signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }).replace(
            USER_A,
            USER_B,
          ),
        }),
      '/reset?error=link_refused',
    ],
    [
      'cut short',
      () =>
        linkQuery({
          type: 'magiclink',
          r: signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A }).slice(0, -2),
        }),
      '/signin?error=link_refused',
    ],
    ['empty', () => linkQuery({ type: 'magiclink', r: '' }), '/signin?error=link_refused'],
    [
      'a short token hash',
      () =>
        `token_hash=abc123&type=recovery&r=${signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A })}`,
      '/reset?error=link_refused',
    ],
  ])('%s: the refused answer, no lookup, nothing spent', async (_label, qs, location) => {
    const res = await GET(getReq(qs()));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}${location}`);
    expect(getUserById).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('an email change with a changed r: its own expired page, no lookup', async () => {
    const r = signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A });
    const res = await GET(getReq(linkQuery({ type: 'email_change', r })));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Nothing about your account has changed');
    expect(getUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['recovery', '/reset?error=link_expired'],
    ['magiclink', '/signin?error=auth_callback_failed'],
    ['invite', '/signin?error=auth_callback_failed'],
  ])('a %s link past its hour: the expired answer, no lookup', async (type, location) => {
    const r = signedRef({ type, tokenHash: HASH_A, userId: USER_A, issued: nowSeconds() - 3901 });
    const res = await GET(getReq(linkQuery({ type, r })));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}${location}`);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('an email change past its hour: its own expired page, no lookup', async () => {
    const r = signedRef({
      type: 'email_change',
      tokenHash: HASH_A,
      userId: USER_A,
      issued: nowSeconds() - 7200,
    });
    const html = await (await GET(getReq(linkQuery({ type: 'email_change', r })))).text();
    expect(html).toContain('This link has expired or was already used');
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe('GET /auth/confirm when the account cannot be named (S25)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an account that is gone (deleted, no email, or disabled): the expired answer, not reported', async () => {
    for (const answer of [
      {
        data: { user: null },
        error: { status: 404, code: 'user_not_found', message: 'User not found' },
      },
      account(null),
      account(EMAIL_A, { banned_until: '2126-01-01T00:00:00Z' }),
    ]) {
      getUserById.mockResolvedValueOnce(answer);
      const res = await GET(getReq(linkQuery({ type: 'recovery' })));
      expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a lookup that fails: a "try again" page with no form and no address, reported with the type only', async () => {
    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 500, code: 'unexpected_failure', message: `boom ${USER_A}` },
    });
    const qs = linkQuery({ type: 'magiclink', next: '/dashboard' });
    const res = await GET(getReq(qs));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('This link could not be opened just now');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(EMAIL_A);
    expect(html).not.toContain(HASH_A);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(context).toEqual({
      tag: 'auth.confirm_recipient_lookup_failed',
      level: 'warning',
      extra: { type: 'magiclink' },
    });
    const reported = JSON.stringify(reportError.mock.calls, (_k, v) =>
      v instanceof Error ? v.message : v,
    );
    expect(reported).not.toContain(USER_A);
    expect(reported).not.toContain(HASH_A);
    expect(reported).not.toContain(new URLSearchParams(qs).get('r')!);
  });

  it('a lookup that takes past five seconds: the same "try again" page', async () => {
    vi.useFakeTimers();
    getUserById.mockReturnValueOnce(new Promise(() => {}));
    const pending = GET(getReq(linkQuery({ type: 'recovery' })));
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain('<form');
    expect(html).not.toContain(EMAIL_A);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'auth.confirm_recipient_lookup_failed',
        extra: { type: 'recovery' },
      }),
    );
  });
});

describe('GET /auth/confirm in a browser that is already signed in', () => {
  it('signed in as the account the link is for: no notice (it was a false alarm)', async () => {
    signedInAs(USER_A, EMAIL_A);
    // An email change of this account, still waiting on its links.
    getUserById.mockResolvedValueOnce(account(EMAIL_A, { new_email: 'new@example.com' }));
    const html = await (await GET(getReq(linkQuery({ type: 'email_change' })))).text();
    expect(html).not.toContain('class="note"');
    expect(html).not.toContain("You're signed in as");
    expect(html).toContain('<form method="post" action="/auth/confirm" data-press-gate>');
  });

  it('signed in as another account: the notice names both, above the same form, and spends nothing', async () => {
    signedInAs(USER_B, EMAIL_B);
    const res = await GET(getReq(linkQuery({ type: 'recovery', next: '/reset/complete' })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<p class="note">You're signed in as <span class="addr" data-press-gate-see>member@example.com</span> on this browser. Continuing signs you in as <span class="addr" data-press-gate-see>person@example.com</span> instead. If you didn't ask for this link, close this page.</p>`,
    );
    expect(html).toContain('form method="post"');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('the same email on another account id still gets the notice: accounts are compared by id', async () => {
    signedInAs(USER_B, EMAIL_A);
    const html = await (await GET(getReq(linkQuery({ type: 'magiclink' })))).text();
    expect(html).toContain(
      'Continuing signs you in as <span class="addr" data-press-gate-see>person@example.com</span> instead.',
    );
  });

  it('escapes the account name it prints', async () => {
    signedInAs(USER_B, 'a<b>"c@example.com');
    const html = await (await GET(getReq(linkQuery({ type: 'invite' })))).text();
    expect(html).toContain(
      '<span class="addr" data-press-gate-see>a&lt;b&gt;&quot;c@example.com</span> on this browser.',
    );
    expect(html).not.toContain('a<b>');
  });

  it('a session with no email still gets the notice, without a name', async () => {
    signedInAs(USER_B, null);
    const html = await (await GET(getReq(linkQuery({ type: 'magiclink' })))).text();
    expect(html).toContain(
      'This browser is already signed in to another StockPilot account. Continuing signs you in as <span class="addr" data-press-gate-see>person@example.com</span> instead.',
    );
  });

  it('a session check that throws: the page still renders, with the line and without the notice', async () => {
    getUser.mockRejectedValueOnce(new Error('network'));
    const res = await GET(getReq(linkQuery({ type: 'recovery' })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('class="note"');
    expect(html).toContain('This link sets a new password for');
    expect(html).toContain('form method="post"');
  });
});

// S25's first release: a link written by an earlier build carries no r. It
// gets the page it got before, with S14's notice when signed in, and is
// logged with its type only. The next release requires r on every link.
describe('GET /auth/confirm for a link written before S25', () => {
  const NOTICE =
    'If this link was sent to a different account, continuing signs you in to that account instead.';

  it('the page as before, with the notice naming the account this browser is signed in as, and a log line with the type only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    signedInAs(USER_B, EMAIL_B);
    const res = await GET(getReq('token_hash=abc123&type=recovery&next=%2Freset%2Fcomplete'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "You're signed in as <strong>member@example.com</strong> on this browser.",
    );
    expect(html).toContain(NOTICE);
    expect(html).toContain("If you didn't ask for this link, close this page.");
    expect(html).toContain('form method="post"');
    expect(html).not.toContain('name="r"');
    expect(html).not.toContain('class="recipient"');
    expect(getUserById).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      '[auth/confirm] link without a recipient',
      { type: 'recovery' },
    ]);
    info.mockRestore();
  });

  it('signed out: no notice, and the press gate as on every form', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const html = await (await GET(getReq('token_hash=abc123&type=recovery'))).text();
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(html).not.toContain(NOTICE);
    expect(html).toContain('This link works once. Press the button to continue.');
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html).toContain(`<script>${PRESS_GATE_SCRIPT}</script>`);
    // The same disabled button and the same words for a browser without
    // scripts as on a signed link's page.
    expect(html.match(/<button\b[^>]*>/gi)).toEqual([
      '<button type="submit" class="btn" disabled>',
    ]);
    expect(html).toContain(
      '<noscript><p class="needs-script">This page needs JavaScript to continue.',
    );
    // No account to name, so nothing for the gate to wait on but the second,
    // and no id for a link to scroll to either.
    expect(html.slice(0, html.indexOf('<script>'))).not.toContain(PRESS_GATE_SEE_ATTR);
    expect(html).not.toMatch(/\sid\s*=/i);
    vi.mocked(console.info).mockRestore();
  });

  it('a session with no email still gets the notice, without a name', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    getUser.mockResolvedValueOnce({ data: { user: { id: USER_B, email: null } }, error: null });
    const html = await (await GET(getReq('token_hash=abc123&type=magiclink'))).text();
    expect(html).toContain('This browser is already signed in to StockPilot.');
    expect(html).toContain(NOTICE);
    vi.mocked(console.info).mockRestore();
  });

  it('a session check that throws: the page still renders, without the notice', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    getUser.mockRejectedValueOnce(new Error('network'));
    const res = await GET(getReq('token_hash=abc123&type=recovery'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(NOTICE);
    expect(html).toContain('form method="post"');
    vi.mocked(console.info).mockRestore();
  });

  it('the log names only a known link type', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await GET(getReq('token_hash=abc123&type=email_change'));
    expect(info.mock.calls).toEqual([
      ['[auth/confirm] link without a recipient', { type: 'email_change' }],
    ]);
    info.mockRestore();
  });
});

// The press gate's field: the page's script adds it to the form when it lets
// a press through (press-gate.test.ts), so a post without it did not come
// through the gate, and is refused before anything is spent.
describe('POST /auth/confirm takes a press only through the press gate (S25)', () => {
  const GATE_LOG = '[auth/confirm] confirmation posted without the press gate field';

  it('a post without the gate field, from this very page and carrying its r: the refused answer of its type, and verifyOtp is never called', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const [type, location] of [
      ['recovery', `${BASE}/reset?error=link_refused`],
      ['invite', `${BASE}/signin?error=link_refused`],
      ['magiclink', `${BASE}/signin?error=link_refused`],
    ] as const) {
      const fields = {
        token_hash: HASH_A,
        type,
        next: '/dashboard',
        r: signedRef({ type, tokenHash: HASH_A, userId: USER_A }),
      };
      const res = await POST(postWithoutGate(fields, SAME_ORIGIN));
      expect(res.status, type).toBe(303);
      expect(res.headers.get('location'), type).toBe(location);
      expect(res.headers.get('set-cookie'), type).toBeNull();
    }
    const change = await POST(
      postWithoutGate(
        {
          token_hash: HASH_A,
          type: 'email_change',
          r: signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(change.status).toBe(200);
    expect(await change.text()).toContain('This link has expired or was already used');
    // Nothing was spent, read or changed.
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(completeEmailChange).not.toHaveBeenCalled();
    // Logged with the type only: never the token or r.
    expect(info.mock.calls).toEqual([
      [GATE_LOG, { type: 'recovery' }],
      [GATE_LOG, { type: 'invite' }],
      [GATE_LOG, { type: 'magiclink' }],
      [GATE_LOG, { type: 'email_change' }],
    ]);
    info.mockRestore();
  });

  it('the very same post with the field is verified', async () => {
    const fields = {
      token_hash: HASH_A,
      type: 'recovery',
      next: '/reset/complete',
      r: signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }),
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await POST(postWithoutGate(fields, SAME_ORIGIN))).headers.get('location')).toBe(
      `${BASE}/reset?error=link_refused`,
    );
    expect(verifyOtp).not.toHaveBeenCalled();
    info.mockRestore();

    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
    const res = await POST(postReq(fields, SAME_ORIGIN));
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: HASH_A });
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
  });

  it('any other value in the field, an empty one, or no form at all is refused the same way', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fields = { token_hash: 'abc123', type: 'recovery', next: '/reset/complete' };
    for (const value of ['', '1', 'true', 'ARMED', ` ${PRESS_GATE_PASSED_VALUE}`]) {
      const res = await POST(
        postWithoutGate({ ...fields, [PRESS_GATE_PASSED_FIELD]: value }, SAME_ORIGIN),
      );
      expect(res.headers.get('location'), JSON.stringify(value)).toBe(
        `${BASE}/reset?error=link_refused`,
      );
    }
    // The field under another name is not the field.
    const renamed = await POST(
      postWithoutGate({ ...fields, gate: PRESS_GATE_PASSED_VALUE }, SAME_ORIGIN),
    );
    expect(renamed.headers.get('location')).toBe(`${BASE}/reset?error=link_refused`);
    // A body that is not a form.
    const noForm = await POST(
      new NextRequest(`${BASE}/auth/confirm`, {
        method: 'POST',
        body: '{"token_hash":"abc123","type":"recovery"}',
        headers: { 'content-type': 'application/json', ...SAME_ORIGIN },
      }),
    );
    expect(noForm.status).toBe(303);
    expect(noForm.headers.get('location')).toBe(`${BASE}/signin?error=link_refused`);
    expect(verifyOtp).not.toHaveBeenCalled();
    vi.mocked(console.info).mockRestore();
  });

  it('a post from another site is still refused first, with or without the field, and is not logged as a gate refusal', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fields = { token_hash: 'abc123', type: 'recovery', next: '/reset/complete' };
    const elsewhere = { 'sec-fetch-site': 'cross-site', origin: 'https://elsewhere.example' };
    for (const req of [postWithoutGate(fields, elsewhere), postReq(fields, elsewhere)]) {
      const res = await POST(req);
      expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_refused`);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('the log names only a known link type, never a value the form chose', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await POST(postWithoutGate({ token_hash: 'abc', type: 'signup<script>' }, SAME_ORIGIN));
    await POST(postWithoutGate({ token_hash: 'abc' }, SAME_ORIGIN));
    expect(info.mock.calls).toEqual([
      [GATE_LOG, { type: 'other' }],
      [GATE_LOG, { type: 'other' }],
    ]);
    info.mockRestore();
  });
});

describe('POST /auth/confirm checks r before the token is spent (S25)', () => {
  it('a press carrying the r its page was given: verified, and lands where its type says', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'magiclink',
          next: '/dashboard',
          r: signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: HASH_A });
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard`);
    expect(signOut).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    [
      'signed for another token',
      'magiclink',
      () => signedRef({ type: 'magiclink', tokenHash: HASH_B, userId: USER_A }),
      '/signin?error=link_refused',
    ],
    [
      'a recovery link relabelled as a sign-in link',
      'magiclink',
      () => signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }),
      '/signin?error=link_refused',
    ],
    [
      'moved to another account',
      'recovery',
      () =>
        signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }).replace(USER_A, USER_B),
      '/reset?error=link_refused',
    ],
    [
      'changed',
      'invite',
      () => signedRef({ type: 'invite', tokenHash: HASH_A, userId: USER_A }).slice(0, -1) + 'x',
      '/signin?error=link_refused',
    ],
    ['empty', 'recovery', () => '', '/reset?error=link_refused'],
  ])(
    'r %s: the refused answer, and verifyOtp is never called',
    async (_label, type, r, location) => {
      verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
      const res = await POST(
        postReq({ token_hash: HASH_A, type, next: '/reset/complete', r: r() }, SAME_ORIGIN),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${BASE}${location}`);
      expect(verifyOtp).not.toHaveBeenCalled();
    },
  );

  it('an email change with a changed r: its own expired page, nothing spent or changed', async () => {
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'email_change',
          r: signedRef({ type: 'email_change', tokenHash: HASH_B, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(await res.text()).toContain('Nothing about your account has changed');
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('r past its hour: the expired answer, and verifyOtp is never called', async () => {
    const stale = (type: string) =>
      signedRef({ type, tokenHash: HASH_A, userId: USER_A, issued: nowSeconds() - 4000 });
    const reset = await POST(
      postReq(
        { token_hash: HASH_A, type: 'recovery', next: '/reset/complete', r: stale('recovery') },
        SAME_ORIGIN,
      ),
    );
    expect(reset.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
    const signIn = await POST(
      postReq(
        { token_hash: HASH_A, type: 'magiclink', next: '/dashboard', r: stale('magiclink') },
        SAME_ORIGIN,
      ),
    );
    expect(signIn.headers.get('location')).toBe(`${BASE}/signin?error=auth_callback_failed`);
    const change = await POST(
      postReq({ token_hash: HASH_A, type: 'email_change', r: stale('email_change') }, SAME_ORIGIN),
    );
    expect(await change.text()).toContain('This link has expired or was already used');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('a press from a link written before S25: answered as before, and logged with its type only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq({ token_hash: 'abc123', type: 'recovery', next: '/reset/complete' }, SAME_ORIGIN),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
    expect(info.mock.calls).toEqual([
      ['[auth/confirm] link without a recipient', { type: 'recovery' }],
    ]);
    info.mockRestore();
  });
});

// A builder that wrote one account's r on another account's token (a bug of
// ours; none is known) must not leave the browser signed in to an account the
// page did not name.
describe('POST /auth/confirm when the session GoTrue made is not the account r names (S25)', () => {
  it('signs this browser out (this session only), reports it with the type only, and answers a page that claims nothing', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_B } } }, error: null });
    const r = signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A });
    const res = await POST(
      postReq({ token_hash: HASH_A, type: 'magiclink', next: '/dashboard', r }, SAME_ORIGIN),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Sign in to continue');
    expect(html).toContain('<a href="/signin" class="btn">');
    expect(html).not.toContain(EMAIL_A);
    expect(html).not.toContain('<form');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'auth.confirm_recipient_mismatch',
      level: 'error',
      extra: { type: 'magiclink' },
    });
    const reported = JSON.stringify(reportError.mock.calls, (_k, v) =>
      v instanceof Error ? v.message : v,
    );
    for (const value of [USER_A, USER_B, HASH_A, r]) expect(reported).not.toContain(value);
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('an email change: the change GoTrue applied is completed for the account it changed first, then the same sign-out', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_B } } }, error: null });
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'email_change',
          r: signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(completeEmailChange).toHaveBeenCalledWith({ userId: USER_B });
    expect(completeEmailChange.mock.invocationCallOrder[0]!).toBeLessThan(
      signOut.mock.invocationCallOrder[0]!,
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('Sign in to continue');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'auth.confirm_recipient_mismatch',
        extra: { type: 'email_change' },
      }),
    );
  });

  it('a sign-out that throws still answers the neutral page', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_B } } }, error: null });
    signOut.mockRejectedValueOnce(new Error('network'));
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'recovery',
          next: '/reset/complete',
          r: signedRef({ type: 'recovery', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('Sign in to continue');
  });

  it('the first email-change confirmation makes no session, so there is nothing to compare', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: USER_B }, session: null }, error: null });
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'email_change',
          r: signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(await res.text()).toContain('One confirmation done');
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('/auth/confirm lands where the link type says, not where the link says', () => {
  it.each([
    ['magiclink', '/dashboard/items/new', '/dashboard'],
    ['magiclink', '/dashboard/settings/billing', '/dashboard'],
    ['magiclink', '/dashboard', '/dashboard'],
    ['magiclink', '/portal', '/portal'],
    ['invite', '/dashboard', '/reset/complete'],
    ['invite', '/portal', '/portal'],
    ['invite', '/reset/complete', '/reset/complete'],
    ['recovery', '/dashboard/settings/integrations', '/reset/complete'],
    ['recovery', '', '/reset/complete'],
  ])('POST %s with next %s: lands on %s', async (type, next, landing) => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq(
        { token_hash: 'abc123', type, next },
        { 'sec-fetch-site': 'same-origin', origin: 'null' },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}${landing}`);
  });

  it('GET carries the landing in its form, not the path the link chose', async () => {
    const html = await (
      await GET(getReq('token_hash=abc123&type=magiclink&next=%2Fdashboard%2Fitems%2Fnew'))
    ).text();
    expect(html).toContain('<input type="hidden" name="next" value="/dashboard">');
    expect(html).not.toContain('/dashboard/items/new');
  });

  it("the reviewer's case: another site sends a signed-in browser to its own sign-in link, and the person presses", async () => {
    signedInAs(USER_B, EMAIL_B);
    const r = signedRef({ type: 'magiclink', tokenHash: HASH_A, userId: USER_A });
    const page = await GET(
      getReq(`token_hash=${HASH_A}&type=magiclink&next=%2Fdashboard%2Fitems%2Fnew&r=${r}`, {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    );
    const html = await page.text();
    // The page must render (a click in webmail is a cross-site navigation too),
    // and now says whose session this browser holds and whose the link is.
    expect(html).toContain(
      'You\'re signed in as <span class="addr" data-press-gate-see>member@example.com</span> on this browser. Continuing signs you in as <span class="addr" data-press-gate-see>person@example.com</span> instead.',
    );
    // Its own form posts same-origin, so the press is verified; the browser
    // lands on the account's home, not on the page the link chose.
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: USER_A } } }, error: null });
    const res = await POST(
      postReq(
        { token_hash: HASH_A, type: 'magiclink', next: '/dashboard/items/new', r },
        SAME_ORIGIN,
      ),
    );
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EMAIL CHANGE (type=email_change, mig 0345). Production runs secure email
// change: two links, one per address, and GoTrue applies the change only when
// BOTH have been verified. Measured 2026-08-25: the first verifyOtp returns no
// session and changes nothing; the second returns a session for the account.
// ─────────────────────────────────────────────────────────────────────────
describe('/auth/confirm — email_change', () => {
  it('GET renders the click-through form for an email_change token without consuming it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await GET(getReq('token_hash=ec123&type=email_change'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm your email change');
    expect(html).toContain('form method="post"');
    expect(html).toContain('ec123');
    expect(verifyOtp).not.toHaveBeenCalled();
    vi.mocked(console.info).mockRestore();
  });

  it('FIRST confirmation (no session returned) renders "one to go" and completes nothing', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: null });
    const res = await POST(postReq({ token_hash: 'side-a', type: 'email_change' }));
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email_change', token_hash: 'side-a' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('One confirmation done');
    expect(html).toContain('/dashboard/settings/profile');
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('SECOND confirmation (session returned) completes the change and lands on Profile', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1', email: 'new@example.com' } } },
      error: null,
    });
    const res = await POST(postReq({ token_hash: 'side-b', type: 'email_change' }));
    expect(completeEmailChange).toHaveBeenCalledWith({ userId: 'u-1' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });

  it('SECOND confirmation carrying its r, for the same account: completes and lands on Profile', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: USER_A }, session: { user: { id: USER_A, email: 'new@example.com' } } },
      error: null,
    });
    const res = await POST(
      postReq(
        {
          token_hash: HASH_A,
          type: 'email_change',
          r: signedRef({ type: 'email_change', tokenHash: HASH_A, userId: USER_A }),
        },
        SAME_ORIGIN,
      ),
    );
    expect(completeEmailChange).toHaveBeenCalledWith({ userId: USER_A });
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('IGNORES next for email_change — the destination is hard-coded', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1' } } },
      error: null,
    });
    const res = await POST(
      postReq({ token_hash: 'side-b', type: 'email_change', next: '/dashboard/orders' }),
    );
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });

  it('an expired/used/tampered email_change link gets its own page, never the /signin bounce, and mutates nothing', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Token has expired or is invalid' } });
    const res = await POST(postReq({ token_hash: 'stale', type: 'email_change' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('expired or was already used');
    expect(html).toContain('Nothing about your account has changed');
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('a completion hook failure never blocks the redirect (best-effort notify)', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1' } } },
      error: null,
    });
    completeEmailChange.mockRejectedValueOnce(new Error('resend down'));
    const res = await POST(postReq({ token_hash: 'side-b', type: 'email_change' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });
});

// Redesign P5.1: the page keeps its words and draws the app's palette in both
// schemes with the flat accent button (the blue-to-indigo gradient predated
// the brand). Its one script is the press gate (S25), inline.
describe('GET /auth/confirm page look', () => {
  it('one inline script (the gate), with the brand palette, a dark scheme and a 44 px button, and no gradient', async () => {
    const res = await GET(getReq(linkQuery({ type: 'invite', next: '/dashboard' })));
    const html = await res.text();
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html).toContain(`<script>${PRESS_GATE_SCRIPT}</script>`);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(html).not.toMatch(/gradient|#3b82f6|#6366f1/i);
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)/);
    expect(html).toContain('background:#fafaf7');
    expect(html).toMatch(/\.btn\{[^}]*min-height:44px/);
    // The button looks inactive until the gate arms it; the address wraps in a
    // face where l, I, 1, O and 0 read apart.
    expect(html).toMatch(/\.btn\[aria-disabled="true"\]\{[^}]*opacity/);
    // It looks the same while it is still disabled, before the gate has run,
    // and the line for a browser without scripts is drawn as a note.
    expect(html).toMatch(/p\.note,p\.needs-script\{[^}]*background:#f9eedc/);
    expect(html).toMatch(/\.btn:disabled,\.btn\[aria-disabled="true"\]\{[^}]*opacity/);
    expect(html).toMatch(/\.addr\{[^}]*monospace[^}]*overflow-wrap:anywhere/);
    expect(html).toContain('<button type="submit" class="btn" disabled>');
    expect(html).toContain('Accept your invite');
    expect(html).toContain('Continue to StockPilot');
    expect(html).toContain('This link works once. Press the button to continue.');
  });

  it('the email-change status page keeps its words and its one link, and loads no script', async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: { message: 'expired' } });
    const res = await POST(postReq({ token_hash: 'x', type: 'email_change' }));
    const html = await res.text();
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain(
      '<a href="/dashboard/settings/profile" class="btn">Go to Settings → Profile</a>',
    );
  });
});
