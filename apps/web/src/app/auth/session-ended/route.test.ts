// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Sec-Fetch-*), and the server receives them as sent.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
const getUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signOut, getUser } })),
}));

import { GET } from './route';

function req(cookies: Record<string, string>, headers: Record<string, string> = {}) {
  const r = new NextRequest('https://stockpilotusa.com/auth/session-ended', { headers });
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
}

function expired(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => /Max-Age=0/i.test(c))
    .map((c) => c.split('=')[0]!);
}

/** What auth-js resolves for a session GoTrue no longer has (session_not_found). */
function sessionGone() {
  const error = Object.assign(new Error('Auth session missing!'), {
    name: 'AuthSessionMissingError',
  });
  return { data: { user: null }, error };
}

describe('GET /auth/session-ended', () => {
  beforeEach(() => vi.clearAllMocks());

  it('signs out locally, expires every Supabase auth cookie (chunked too), and sends the browser to sign-in with the reason', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const res = await GET(
      req({
        'sb-xizp-auth-token.0': 'a',
        'sb-xizp-auth-token.1': 'b',
        'sb-xizp-auth-token': 'c',
        'sp-theme': 'dark',
      }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://stockpilotusa.com/signin?reason=session_ended');
    expect(expired(res).sort()).toEqual(['sb-xizp-auth-token', 'sb-xizp-auth-token.0', 'sb-xizp-auth-token.1']);
  });

  it('still clears the cookies when signOut itself fails (no redirect loop left behind)', async () => {
    signOut.mockRejectedValueOnce(new Error('network'));
    const res = await GET(req({ 'sb-xizp-auth-token': 'c' }));
    expect(res.headers.get('location')).toContain('/signin?reason=session_ended');
    expect(expired(res)).toEqual(['sb-xizp-auth-token']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ANOTHER ORIGIN CANNOT END A LIVE SESSION (docket S14 review). This is a GET,
// which the cross-site write rule never judges, and the browser sends the
// session cookie with a top-level navigation from any site (SameSite=Lax) and
// with an image or script a sibling subdomain loads (the same site). So a link,
// a redirect or an <img> on another origin's page could sign the person out:
// the first step of a login CSRF (sign them out, then offer a sign-in link for
// an account the attacker holds). Now a request another origin's page made
// only clears a session that is ALREADY gone, which is what the dashboard's
// own redirect sends here for; a live one is left alone and the browser goes
// to the dashboard.
// ─────────────────────────────────────────────────────────────────────────
describe('GET /auth/session-ended sent by a page on another origin', () => {
  beforeEach(() => vi.clearAllMocks());

  const LIVE = { data: { user: { id: 'u-1', email: 'member@example.com' } }, error: null };
  const SESSION = { 'sb-xizp-auth-token': 'live-session' };

  it.each([
    [
      'a link or redirect on another site (top-level navigation)',
      {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    ],
    [
      'an image on a sibling subdomain',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    ],
    [
      'a frame on a sibling subdomain',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    ],
    ['an unknown Sec-Fetch-Site value (fail closed)', { 'sec-fetch-site': 'cross-origin' }],
  ])(
    '%s, with a live session: not signed out, no cookie expired, sent to the dashboard',
    async (_name, headers) => {
      getUser.mockResolvedValueOnce(LIVE);
      const res = await GET(req(SESSION, headers));
      expect(signOut).not.toHaveBeenCalled();
      expect(expired(res)).toEqual([]);
      expect(res.headers.get('location')).toBe('https://stockpilotusa.com/dashboard');
    },
  );

  it("the dashboard's own redirect after a link from another site, the session already gone: cleared as before", async () => {
    // A person whose session was revoked elsewhere follows an emailed link from
    // webmail: the layout redirects here, and the browser reports the whole
    // chain as cross-site. That session must still be cleared, or the stale
    // cookie bounces /signin straight back to /dashboard.
    getUser.mockResolvedValueOnce(sessionGone());
    signOut.mockResolvedValueOnce({ error: null });
    const res = await GET(
      req(SESSION, {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(expired(res)).toEqual(['sb-xizp-auth-token']);
    expect(res.headers.get('location')).toBe(
      'https://stockpilotusa.com/signin?reason=session_ended',
    );
  });

  it('any answer without a user is not a live session (a refresh token GoTrue no longer has): cleared', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: null },
      error: Object.assign(new Error('Invalid Refresh Token'), {
        name: 'AuthApiError',
        status: 400,
      }),
    });
    const res = await GET(req(SESSION, { 'sec-fetch-site': 'same-site' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(expired(res)).toEqual(['sb-xizp-auth-token']);
  });

  it('a session check that throws is not a live session either: cleared, so no redirect loop is left', async () => {
    getUser.mockRejectedValueOnce(new Error('network'));
    const res = await GET(req(SESSION, { 'sec-fetch-site': 'cross-site' }));
    expect(expired(res)).toEqual(['sb-xizp-auth-token']);
    expect(res.headers.get('location')).toContain('/signin?reason=session_ended');
  });

  it.each([
    [
      "the app's own page (the error screen's Sign out and back in link)",
      {
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    ],
    [
      'the person typed the address or used a bookmark',
      { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    ],
    ['a browser that sends no Fetch Metadata', {}],
  ])(
    '%s: signed out as before, live session or not, without asking GoTrue first',
    async (_name, headers) => {
      getUser.mockResolvedValue(LIVE);
      signOut.mockResolvedValueOnce({ error: null });
      const res = await GET(req(SESSION, headers));
      expect(getUser).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(expired(res)).toEqual(['sb-xizp-auth-token']);
      expect(res.headers.get('location')).toBe(
        'https://stockpilotusa.com/signin?reason=session_ended',
      );
    },
  );
});
