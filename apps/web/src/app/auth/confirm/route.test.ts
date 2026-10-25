// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const verifyOtp = vi.fn();
// The browser's current session, read by GET (the signed-in notice). Signed
// out unless a test says otherwise.
const getUser = vi.fn(async () => ({
  data: { user: null as { id: string; email?: string | null } | null },
  error: null,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp, getUser } }),
}));
const completeEmailChange = vi.fn(async (_args: { userId: string }) => ({
  email: 'new@example.com',
  notifiedPreviousEmail: 'old@example.com',
}));
vi.mock('@/server/services/email-change', () => ({
  completeEmailChange: (args: { userId: string }) => completeEmailChange(args),
  EMAIL_CHANGE_RETURN_PATH: '/dashboard/settings/profile',
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { GET, POST } from './route';

const BASE = 'https://app.example.com';

function getReq(qs: string): NextRequest {
  return new NextRequest(`${BASE}/auth/confirm?${qs}`);
}

function postReq(
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

describe('GET /auth/confirm', () => {
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

  it.each(['cross-site', 'same-site', 'none'])(
    'Sec-Fetch-Site %s: the failure answer, and the token is not spent',
    async (site) => {
      verifyOtp.mockResolvedValue({ error: null });
      const res = await POST(
        postReq(
          { token_hash: 'held-by-another-page', type: 'recovery', next: '/reset/complete' },
          { 'sec-fetch-site': site, origin: 'https://evil.example' },
        ),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
      expect(verifyOtp).not.toHaveBeenCalled();
    },
  );

  it('an invite or a sign-in link from another site: the /signin bounce, never a session', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    for (const type of ['invite', 'magiclink']) {
      const res = await POST(
        postReq(
          { token_hash: 'held', type, next: '/dashboard' },
          { 'sec-fetch-site': 'cross-site' },
        ),
      );
      expect(res.headers.get('location'), type).toBe(`${BASE}/signin?error=auth_callback_failed`);
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
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq(
        { token_hash: 'abc123', type: 'recovery', next: '/reset/complete' },
        { origin: 'null' },
      ),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toEqual({ type: 'recovery' });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('/reset/complete');
    info.mockRestore();
  });

  it('the log names only a known link type, never a value the form chose', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await POST(postReq({ token_hash: 'abc123', type: 'x'.repeat(5000) }));
    expect(info.mock.calls[0]![1]).toEqual({ type: 'other' });
    info.mockRestore();
  });

  it("this route's own page with Sec-Fetch-Site same-origin is not logged", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    verifyOtp.mockResolvedValue({ error: null });
    await POST(
      postReq(
        { token_hash: 'abc123', type: 'recovery', next: '/reset/complete' },
        { 'sec-fetch-site': 'same-origin', origin: 'null' },
      ),
    );
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NAVIGATE AND PRESS (docket S14 review). Refusing a post from another site
// does not stop another site from SENDING the browser to this page with a link
// it holds for its own account: the page must render for a click in webmail,
// which is a cross-site navigation too, and its form then posts from the app's
// own page (same-origin). So the page now says which account the browser is
// already signed in as, and where the link lands is fixed by its type, not
// chosen by the link. (Another site can no longer sign the browser out first:
// app/auth/session-ended.)
// ─────────────────────────────────────────────────────────────────────────
describe('GET /auth/confirm in a browser that is already signed in', () => {
  beforeEach(() => vi.clearAllMocks());

  const NOTICE =
    'If this link was sent to a different account, continuing signs you in to that account instead.';

  it('names the account this browser is signed in as, above the same form, and spends nothing', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: 'u-1', email: 'member@example.com' } },
      error: null,
    });
    const res = await GET(getReq('token_hash=abc123&type=recovery&next=%2Freset%2Fcomplete'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "You're signed in as <strong>member@example.com</strong> on this browser.",
    );
    expect(html).toContain(NOTICE);
    expect(html).toContain("If you didn't ask for this link, close this page.");
    expect(html).toContain('form method="post"');
    expect(html).not.toMatch(/<script\b/i);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('escapes the account name it prints', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: 'u-1', email: 'a<b>"c@example.com' } },
      error: null,
    });
    const html = await (await GET(getReq('token_hash=abc123&type=invite'))).text();
    expect(html).toContain('<strong>a&lt;b&gt;&quot;c@example.com</strong>');
    expect(html).not.toContain('a<b>');
  });

  it('a session with no email still gets the notice, without a name', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'u-1', email: null } }, error: null });
    const html = await (await GET(getReq('token_hash=abc123&type=magiclink'))).text();
    expect(html).toContain('This browser is already signed in to StockPilot.');
    expect(html).toContain(NOTICE);
  });

  it('signed out (an email scanner, a new device): no notice', async () => {
    const html = await (await GET(getReq('token_hash=abc123&type=recovery'))).text();
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(html).not.toContain(NOTICE);
    expect(html).toContain('This link works once. Press the button to continue.');
  });

  it('a session check that throws: the page still renders, without the notice', async () => {
    getUser.mockRejectedValueOnce(new Error('network'));
    const res = await GET(getReq('token_hash=abc123&type=recovery'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(NOTICE);
    expect(html).toContain('form method="post"');
  });
});

describe('/auth/confirm lands where the link type says, not where the link says', () => {
  beforeEach(() => vi.clearAllMocks());

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
    getUser.mockResolvedValueOnce({
      data: { user: { id: 'u-1', email: 'member@example.com' } },
      error: null,
    });
    const page = await GET(
      new NextRequest(
        `${BASE}/auth/confirm?token_hash=attackers-own-link&type=magiclink&next=%2Fdashboard%2Fitems%2Fnew`,
        {
          headers: {
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        },
      ),
    );
    const html = await page.text();
    // The page must render (a click in webmail is a cross-site navigation too),
    // and now says whose session this browser holds.
    expect(html).toContain(
      "You're signed in as <strong>member@example.com</strong> on this browser.",
    );
    // Its own form posts same-origin, so the press is verified; the browser
    // lands on the account's home, not on the page the link chose.
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq(
        { token_hash: 'attackers-own-link', type: 'magiclink', next: '/dashboard/items/new' },
        { 'sec-fetch-site': 'same-origin', origin: 'null' },
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
  beforeEach(() => vi.clearAllMocks());

  it('GET renders the click-through form for an email_change token without consuming it', async () => {
    const res = await GET(getReq('token_hash=ec123&type=email_change'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm your email change');
    expect(html).toContain('form method="post"');
    expect(html).toContain('ec123');
    expect(verifyOtp).not.toHaveBeenCalled();
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

// Redesign P5.1: the page keeps zero JS and its words, and draws the app's
// palette in both schemes with the flat accent button (the blue-to-indigo
// gradient predated the brand).
describe('GET /auth/confirm page look', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is zero JS, with the brand palette, a dark scheme and a 44 px button, and no gradient', async () => {
    const res = await GET(getReq('token_hash=abc123&type=invite&next=%2Fdashboard'));
    const html = await res.text();
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/gradient|#3b82f6|#6366f1/i);
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)/);
    expect(html).toContain('background:#fafaf7');
    expect(html).toMatch(/\.btn\{[^}]*min-height:44px/);
    expect(html).toContain('<button type="submit" class="btn">');
    expect(html).toContain('Accept your invite');
    expect(html).toContain('Continue to StockPilot');
    expect(html).toContain('This link works once. Press the button to continue.');
  });

  it('the email-change status page keeps its words and its one link', async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: { message: 'expired' } });
    const res = await POST(postReq({ token_hash: 'x', type: 'email_change' }));
    const html = await res.text();
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain(
      '<a href="/dashboard/settings/profile" class="btn">Go to Settings → Profile</a>',
    );
  });
});
