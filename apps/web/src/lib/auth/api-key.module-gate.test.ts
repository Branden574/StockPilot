import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * withApiKey() is the runtime gate for the api_access module: nothing else
 * stands between a minted key and an organization's public API. It reads the
 * module through the ONE access rule, so a comped organization's keys work (the
 * Settings panel that mints them is offered to it) and everyone else's behave
 * exactly as before.
 *
 * A module state the two reads could not decide is neither: the key is
 * answered 503 with a Retry-After (never the 403 of a module that is off),
 * nothing is served, and the failed check is reported once as a warning.
 */

const state = vi.hoisted(() => ({
  key: {
    id: 'key-1',
    organization_id: 'org-1',
    scopes: ['items:read'],
    revoked_at: null,
    expires_at: null,
  } as Record<string, unknown> | null,
  /** The organization_modules row for api_access; null = no row. */
  row: null as { enabled?: boolean } | null,
  rowError: null as unknown,
  comped: false as boolean | null,
  orgError: null as unknown,
  lastUsedStamps: 0,
}));

const report = vi.hoisted(() => ({ calls: [] as Array<[unknown, Record<string, unknown>]> }));
vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async (e: unknown, ctx: Record<string, unknown>) => {
    report.calls.push([e, ctx]);
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      let op = 'select';
      q.select = () => q;
      q.eq = () => q;
      q.limit = () => q;
      q.update = () => {
        op = 'update';
        return q;
      };
      // The list reads of the module check, and the last-used stamp.
      q.then = (ok: (v: unknown) => unknown) => {
        if (op === 'update') {
          state.lastUsedStamps += 1;
          return Promise.resolve({ data: null, error: null }).then(ok);
        }
        if (table === 'organization_modules') {
          return Promise.resolve(
            state.rowError
              ? { data: null, error: state.rowError }
              : { data: state.row ? [state.row] : [], error: null },
          ).then(ok);
        }
        if (table === 'organizations') {
          return Promise.resolve(
            state.orgError
              ? { data: null, error: state.orgError }
              : { data: [{ all_modules_comp: state.comped }], error: null },
          ).then(ok);
        }
        return Promise.resolve({ data: null, error: null }).then(ok);
      };
      q.maybeSingle = async () => {
        if (table === 'api_keys') return { data: state.key, error: null };
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

const UNREAD = { message: 'upstream timeout', code: '57014' };

beforeEach(() => {
  state.row = null;
  state.rowError = null;
  state.comped = false;
  state.orgError = null;
  state.lastUsedStamps = 0;
  report.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('withApiKey: the api_access gate', () => {
  it('refuses a key whose organization does not have API access', async () => {
    const res = await withApiKey(request());
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(report.calls).toEqual([]);
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

  it('an enabled row that was read still opens the API when the comp flag cannot be read', async () => {
    state.row = { enabled: true };
    state.orgError = UNREAD;
    expect(await withApiKey(request())).toMatchObject({ ok: true });
  });
});

describe('withApiKey: a module state that could not be read', () => {
  it.each([
    ['the comp flag', () => (state.orgError = UNREAD)],
    ['the rows', () => (state.rowError = UNREAD)],
    [
      'both',
      () => {
        state.orgError = UNREAD;
        state.rowError = UNREAD;
      },
    ],
  ])('%s unread: 503 with a Retry-After, never 403, and the key is not served', async (_n, arm) => {
    arm();
    const res = await withApiKey(request());
    expect(res).toEqual({
      ok: false,
      status: 503,
      error: 'API access could not be checked. Please try again.',
      retryAfter: 5,
    });
    // Refused before the per-key work: no last-used stamp.
    expect(state.lastUsedStamps).toBe(0);
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]![1]).toEqual({
      tag: 'public_api.module_state',
      level: 'warning',
      organizationId: 'org-1',
    });
  });

  it('a comp flag that cannot be read is never a comp', async () => {
    // The flag would have said yes: unread, it grants nothing.
    state.comped = true;
    state.orgError = UNREAD;
    expect(await withApiKey(request())).toMatchObject({ ok: false, status: 503 });
  });
});
