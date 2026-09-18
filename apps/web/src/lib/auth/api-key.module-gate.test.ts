import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * withApiKey() is the runtime gate for the api_access module: nothing else
 * stands between a minted key and an organization's public API. It reads the
 * module through the ONE access rule, so a comped organization's keys work (the
 * Settings panel that mints them is offered to it) and everyone else's behave
 * exactly as before.
 */

const state = vi.hoisted(() => ({
  key: {
    id: 'key-1',
    organization_id: 'org-1',
    scopes: ['items:read'],
    revoked_at: null,
    expires_at: null,
  } as Record<string, unknown> | null,
  row: null as { enabled?: boolean } | null,
  comped: false as boolean | null,
  orgError: null as unknown,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.update = () => q;
      q.then = (ok: () => void) => Promise.resolve().then(ok);
      q.maybeSingle = async () => {
        if (table === 'api_keys') return { data: state.key, error: null };
        if (table === 'organization_modules') return { data: state.row, error: null };
        if (table === 'organizations')
          return state.orgError
            ? { data: null, error: state.orgError }
            : { data: { all_modules_comp: state.comped }, error: null };
        return { data: null, error: null };
      };
      return q;
    },
  }),
}));

import { generateApiKey, withApiKey } from './api-key';

const request = () =>
  new Request('https://app.test/api/public/v1/items', {
    headers: { authorization: `Bearer ${generateApiKey().key}` },
  });

beforeEach(() => {
  state.row = null;
  state.comped = false;
  state.orgError = null;
});

describe('withApiKey: the api_access gate', () => {
  it('refuses a key whose organization does not have API access', async () => {
    const res = await withApiKey(request());
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts it with an explicit enabled row, as before', async () => {
    state.row = { enabled: true };
    expect(await withApiKey(request())).toMatchObject({
      ok: true,
      ctx: { organizationId: 'org-1' },
    });
  });

  it('accepts a COMPED organization with no row: the keys its Settings panel mints must work', async () => {
    state.comped = true;
    expect(await withApiKey(request())).toMatchObject({ ok: true });
  });

  it('accepts a comped organization whose seeded row says OFF', async () => {
    state.comped = true;
    state.row = { enabled: false };
    expect(await withApiKey(request())).toMatchObject({ ok: true });
  });

  it('FAILS CLOSED when the comp flag cannot be read', async () => {
    state.comped = true;
    state.orgError = { message: 'upstream timeout' };
    expect(await withApiKey(request())).toMatchObject({ ok: false, status: 403 });
  });
});
