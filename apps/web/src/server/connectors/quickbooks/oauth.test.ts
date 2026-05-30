import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exchangeCode, refreshTokens } from './oauth';

// The env module reads QBO_* from process.env at import time. These tests set
// process.env BEFORE importing via the static import above is fine because the
// env module memoizes — so we instead assert behaviour that doesn't depend on a
// real client secret by spying on fetch and inspecting the request the OAuth
// helpers assemble.

const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

type FetchCall = [string | URL, RequestInit];

describe('quickbooks oauth', () => {
  let fetchSpy: ReturnType<typeof vi.fn<(input: string | URL, init: RequestInit) => Promise<Response>>>;

  const callAt = (i: number): FetchCall => fetchSpy.mock.calls[i] as unknown as FetchCall;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exchangeCode posts to the token endpoint and derives expiresAt from expires_in', async () => {
    const before = Date.now();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
        token_type: 'bearer',
      }),
    );

    const out = await exchangeCode('the-code', 'realm-9');

    // POSTed to the Intuit token endpoint with form-encoded auth-code grant.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = callAt(0);
    expect(calledUrl).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Accept).toBe('application/json');
    // HTTP Basic auth header present (never logs the secret).
    expect(headers.Authorization).toMatch(/^Basic /);
    const body = String(init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');

    expect(out.accessToken).toBe('access-1');
    expect(out.refreshToken).toBe('refresh-1');
    expect(out.realmId).toBe('realm-9');
    const expiresAtMs = new Date(out.expiresAt).getTime();
    // ~1 hour out (allow a small skew window for test execution time).
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600_000 - 5000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000 + 5000);
  });

  it('refreshTokens returns the NEW rotated refresh_token (not the old one)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-2',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
        token_type: 'bearer',
      }),
    );

    const out = await refreshTokens('old-refresh');

    const [, init] = callAt(0);
    const body = String(init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=old-refresh');

    // The rotated token MUST be returned and persisted — never the old one.
    expect(out.refreshToken).toBe('rotated-refresh');
    expect(out.refreshToken).not.toBe('old-refresh');
    expect(out.accessToken).toBe('access-2');
    expect(typeof out.expiresAt).toBe('string');
  });

  it('exchangeCode surfaces a non-OK response as an error (no token leak)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { error: 'invalid_grant' },
        { status: 400, headers: { intuit_tid: 'tid-abc' } },
      ),
    );

    await expect(exchangeCode('bad', 'realm')).rejects.toThrow(/invalid_grant|400/);
  });
});
