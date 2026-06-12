import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    SAGE_INTACCT_CLIENT_ID: 'client-id',
    SAGE_INTACCT_CLIENT_SECRET: 'client-secret',
  },
}));

import { exchangeCode, refreshTokens } from './oauth';

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sage-intacct oauth', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchangeCode posts the auth-code grant and derives expiresAt', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 43200, companyId: 'co-1' }),
    );
    const before = Date.now();
    const res = await exchangeCode('the-code');

    expect(res.accessToken).toBe('at');
    expect(res.refreshToken).toBe('rt');
    expect(res.companyId).toBe('co-1');
    // ~12h out
    const expires = Date.parse(res.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 43000 * 1000);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.intacct.com/ia/api/v1/oauth2/token');
    const body = String(init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
    expect(body).toContain(
      `redirect_uri=${encodeURIComponent('https://app.test/api/integrations/sage_intacct/callback')}`,
    );
  });

  it('exchangeCode returns null companyId when absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 43200 }),
    );
    const res = await exchangeCode('c');
    expect(res.companyId).toBeNull();
  });

  it('refreshTokens persists a rotated refresh token', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at2', refresh_token: 'rt2', expires_in: 43200 }),
    );
    const res = await refreshTokens('rt1');
    expect(res.refreshToken).toBe('rt2');
  });

  it('refreshTokens keeps the old refresh token when the response omits one', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at2', refresh_token: '', expires_in: 43200 }),
    );
    const res = await refreshTokens('rt1');
    expect(res.refreshToken).toBe('rt1');
  });

  it('throws a token-free error on a non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ error: 'invalid_grant', error_description: 'expired' }, 400),
    );
    await expect(exchangeCode('bad')).rejects.toThrow(/status 400/);
  });
});
