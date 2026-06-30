import { describe, expect, it, vi } from 'vitest';

import { buildAuthorizeUrl, exchangeCode, refreshTokens } from './oauth';

describe('zendesk oauth', () => {
  it('builds an authorize URL on the org subdomain with state + scopes', () => {
    const url = buildAuthorizeUrl('acme', 'STATE123', 'read');
    expect(url).toContain('https://acme.zendesk.com/oauth/authorizations/new');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=STATE123');
    expect(url).toContain('scope=read');
  });

  it('rejects an invalid subdomain in buildAuthorizeUrl', () => {
    expect(() => buildAuthorizeUrl('bad subdomain!', 'STATE', 'read')).toThrow(/subdomain/i);
  });

  it('exchanges a code for tokens + derives expiresAt', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await exchangeCode('acme', 'code123', fetchSpy as unknown as typeof fetch);
    expect(r.accessToken).toBe('at');
    expect(r.refreshToken).toBe('rt');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://acme.zendesk.com/oauth/tokens',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('exchangeCode throws on non-OK response (no token leak)', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      exchangeCode('acme', 'bad-code', fetchSpy as unknown as typeof fetch),
    ).rejects.toThrow(/400/);
  });

  it('refreshTokens returns the rotated refresh token', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await refreshTokens('acme', 'old-rt', fetchSpy as unknown as typeof fetch);
    expect(r.accessToken).toBe('at2');
    expect(r.refreshToken).toBe('rt2');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshTokens falls back to the input refreshToken when response omits it', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'at3', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await refreshTokens('acme', 'kept-rt', fetchSpy as unknown as typeof fetch);
    expect(r.refreshToken).toBe('kept-rt');
  });

  it('rejects an invalid subdomain in exchangeCode', async () => {
    const fetchSpy = vi.fn();
    await expect(
      exchangeCode('bad domain!', 'code', fetchSpy as unknown as typeof fetch),
    ).rejects.toThrow(/subdomain/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
