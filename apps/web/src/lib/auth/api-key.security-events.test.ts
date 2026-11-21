import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * withApiKey's security event (part 1 of the security tools): a well-formed
 * key that matches no key (the 401 "Invalid API key." answer) is
 * password_guessing / blocked / unknown_api_key from the api source, with no
 * organization (the key names none) and the request's own headers. A
 * malformed header, a read that failed, a revoked or an expired key, and a
 * key that resolves record nothing.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const state = vi.hoisted(() => ({
  key: null as Record<string, unknown> | null,
  keyError: null as unknown,
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 }),
}));
vi.mock('@/lib/modules/org-may-use-module', () => ({ orgMayUseModule: vi.fn(async () => true) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.update = () => q;
      q.maybeSingle = async () => ({ data: state.key, error: state.keyError });
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      return q;
    },
  }),
}));

import { recordSecurityEvent } from '@/server/security/events';

import { withApiKey } from './api-key';

const KEY = `sk_live_${'ab'.repeat(24)}`;
const req = (authorization?: string) =>
  new Request('https://app.example.com/api/public/v1/items', {
    headers: {
      'x-real-ip': '203.0.113.9',
      ...(authorization === undefined ? {} : { authorization }),
    },
  });

beforeEach(() => {
  state.key = null;
  state.keyError = null;
});

describe('withApiKey records an unknown key', () => {
  it('a well-formed key that matches no key: unknown_api_key, api, no organization', async () => {
    const request = req(`Bearer ${KEY}`);
    expect(await withApiKey(request)).toEqual({ ok: false, status: 401, error: 'Invalid API key.' });
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      { category: 'password_guessing', outcome: 'blocked', reason: 'unknown_api_key', source: 'api' },
      request.headers,
    );
  });

  it('a malformed or missing key records nothing', async () => {
    await withApiKey(req());
    await withApiKey(req('Bearer not-a-key'));
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it('a read that failed answers the same 401 and records nothing', async () => {
    state.keyError = { code: '57014', message: 'timeout' };
    expect(await withApiKey(req(`Bearer ${KEY}`))).toMatchObject({ status: 401, error: 'Invalid API key.' });
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it('a revoked, an expired or a working key records nothing', async () => {
    const base = { id: 'key-1', organization_id: 'org-1', scopes: [], revoked_at: null, expires_at: null };
    state.key = { ...base, revoked_at: '2026-11-01T00:00:00Z' };
    expect(await withApiKey(req(`Bearer ${KEY}`))).toMatchObject({ error: 'API key revoked.' });
    state.key = { ...base, expires_at: '2026-01-01T00:00:00Z' };
    expect(await withApiKey(req(`Bearer ${KEY}`))).toMatchObject({ error: 'API key expired.' });
    state.key = base;
    expect(await withApiKey(req(`Bearer ${KEY}`))).toMatchObject({ ok: true });
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});
