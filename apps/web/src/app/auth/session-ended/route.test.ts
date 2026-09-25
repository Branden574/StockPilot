import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signOut } })),
}));

import { GET } from './route';

function req(cookies: Record<string, string>) {
  const r = new NextRequest('https://stockpilotusa.com/auth/session-ended');
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
}

function expired(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => /Max-Age=0/i.test(c))
    .map((c) => c.split('=')[0]!);
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
