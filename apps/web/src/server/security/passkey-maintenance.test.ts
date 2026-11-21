import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduled passkey upkeep (plan 10.3). The database answers are given
 * rows in the shapes 0475 returns (passkey_account_states,
 * purge_passkey_records); what is checked is what the server then deletes,
 * drops and reports. The real functions run in the lab (part-2-web/stage4
 * report). The hourly bridge session check is passkey-detector.test.ts.
 */

const h = vi.hoisted(() => ({
  rp: { rpId: 'localhost', origins: ['http://localhost:3000'] } as {
    rpId: string;
    origins: string[];
  } | null,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  settings: { data: { passkeys_on: true }, error: null } as { data: unknown; error: unknown },
  deleted: [] as string[],
  reports: [] as Array<{ tag: string; level?: string; extra?: Record<string, unknown> }>,
  health: { version: 'v2.198.0' } as unknown,
}));

vi.mock('@/lib/auth/passkey-relying-party', () => ({ passkeyRelyingParty: () => h.rp }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sample-anon-value',
  },
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: async (
    _e: unknown,
    ctx: { tag: string; level?: string; extra?: Record<string, unknown> },
  ) => {
    h.reports.push(ctx);
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args?: unknown) => {
      h.rpcCalls.push({ name, args });
      return h.rpc[name] ?? { data: null, error: { code: 'PGRST202' } };
    },
    from: (table: string) => {
      const q = {
        select: () => q,
        limit: () => q,
        maybeSingle: async () => {
          expect(table).toBe('platform_settings');
          return h.settings;
        },
      };
      return q;
    },
    auth: {
      admin: {
        mfa: {
          deleteFactor: async ({ id }: { id: string; userId: string }) => {
            h.deleted.push(id);
            return { data: { id }, error: null };
          },
        },
      },
    },
  }),
}));

import { runPasskeyMaintenance } from './passkey-maintenance';

const U = '11111111-1111-4111-8111-111111111111';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

function stateRow(state: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: U,
    state,
    bridge_factor_id: null,
    bridge_factor_status: null,
    bridge_factor_created_at: null,
    reserved_factors: [],
    ...extra,
  };
}

beforeEach(() => {
  h.rp = { rpId: 'localhost', origins: ['http://localhost:3000'] };
  h.rpc = {
    purge_passkey_records: {
      data: [{ challenges_deleted: 4, removed_passkeys_deleted: 1 }],
      error: null,
    },
    passkey_account_states: { data: [], error: null },
    passkey_drop_bridge: { data: true, error: null },
  };
  h.rpcCalls = [];
  h.settings = { data: { passkeys_on: true }, error: null };
  h.deleted = [];
  h.reports = [];
  h.health = { version: 'v2.198.0' };
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toBe('http://127.0.0.1:54321/auth/v1/health');
    return new Response(JSON.stringify(h.health), { status: 200 });
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const tags = () => h.reports.map((r) => r.tag);

describe('runPasskeyMaintenance (10.3)', () => {
  it('without a site (a preview) it does nothing at all', async () => {
    h.rp = null;
    const s = await runPasskeyMaintenance();
    expect(s.ran).toBe(false);
    expect(h.rpcCalls).toEqual([]);
  });

  it('before 0475 (the purge function is missing) it stops quietly', async () => {
    h.rpc.purge_passkey_records = { data: null, error: { code: 'PGRST202' } };
    const s = await runPasskeyMaintenance();
    expect(s.ran).toBe(false);
    expect(h.rpcCalls.map((c) => c.name)).toEqual(['purge_passkey_records']);
    expect(h.reports).toEqual([]);
  });

  it('purges, reads the states for this site and says the Auth version is proven', async () => {
    const s = await runPasskeyMaintenance();
    expect(s).toMatchObject({
      ran: true,
      purged: { challenges: 4, removedPasskeys: 1 },
      authVersion: 'proven',
    });
    expect(h.rpcCalls[1]).toEqual({
      name: 'passkey_account_states',
      args: { p_rp_id: 'localhost' },
    });
    expect(h.reports).toEqual([]);
  });

  it('an unverified reserved factor older than ten minutes is deleted; a young one is kept', async () => {
    h.rpc.passkey_account_states = {
      data: [
        stateRow('unverified_reserved_factor', {
          reserved_factors: [
            { factor_id: 'old', status: 'unverified', created_at: ago(11 * MIN) },
            { factor_id: 'young', status: 'unverified', created_at: ago(1 * MIN) },
            { factor_id: 'untimed', status: 'unverified', created_at: null },
          ],
        }),
      ],
      error: null,
    };
    const s = await runPasskeyMaintenance();
    expect(h.deleted).toEqual(['old']);
    expect(s.swept).toBe(1);
  });

  it('S13 removal_unfinished: the verified leftovers go; an unverified one in flight stays', async () => {
    h.rpc.passkey_account_states = {
      data: [
        stateRow('removal_unfinished', {
          reserved_factors: [
            { factor_id: 'leftover', status: 'verified', created_at: ago(60 * MIN) },
            { factor_id: 'new-add', status: 'unverified', created_at: ago(30_000) },
          ],
        }),
      ],
      error: null,
    };
    const s = await runPasskeyMaintenance();
    expect(h.deleted).toEqual(['leftover']);
    expect(s.removalsFinished).toBe(1);
  });

  it('S7 bridge_row_without_passkey with a verified bridge: the factor, then the row', async () => {
    h.rpc.passkey_account_states = {
      data: [
        stateRow('bridge_row_without_passkey', {
          bridge_factor_id: 'b-1',
          bridge_factor_status: 'verified',
        }),
      ],
      error: null,
    };
    const s = await runPasskeyMaintenance();
    expect(h.deleted).toEqual(['b-1']);
    expect(h.rpcCalls.at(-1)).toEqual({
      name: 'passkey_drop_bridge',
      args: { p_user_id: U, p_factor_id: 'b-1' },
    });
    expect(s.removalsFinished).toBe(1);
  });

  it('S5: a row whose factor is gone is dropped; one whose unverified factor is young is left', async () => {
    h.rpc.passkey_account_states = {
      data: [
        stateRow('bridge_row_without_passkey', {
          bridge_factor_id: 'gone',
          bridge_factor_status: null,
        }),
      ],
      error: null,
    };
    await runPasskeyMaintenance();
    expect(h.rpcCalls.at(-1)).toEqual({
      name: 'passkey_drop_bridge',
      args: { p_user_id: U, p_factor_id: 'gone' },
    });

    h.rpcCalls = [];
    h.rpc.passkey_account_states = {
      data: [
        stateRow('bridge_row_without_passkey', {
          bridge_factor_id: 'young',
          bridge_factor_status: 'unverified',
          bridge_factor_created_at: ago(1 * MIN),
        }),
      ],
      error: null,
    };
    await runPasskeyMaintenance();
    expect(h.deleted).toEqual([]);
    expect(h.rpcCalls.map((c) => c.name)).not.toContain('passkey_drop_bridge');
  });

  for (const state of [
    'bridge_newer_than_removal',
    'bridge_without_passkey',
    'reserved_factor_without_row',
  ]) {
    it(`${state} is never finished automatically: nothing verified is deleted, an error is reported`, async () => {
      h.rpc.passkey_account_states = {
        data: [
          stateRow(state, {
            bridge_factor_id: 'b-1',
            bridge_factor_status: 'verified',
            reserved_factors: [{ factor_id: 'v-1', status: 'verified', created_at: ago(60 * MIN) }],
          }),
        ],
        error: null,
      };
      await runPasskeyMaintenance();
      expect(h.deleted).toEqual([]);
      expect(h.rpcCalls.map((c) => c.name)).not.toContain('passkey_drop_bridge');
      const report = h.reports.find((r) => r.tag === 'passkeys.accounts_fail_closed');
      expect(report?.level).toBe('error');
      expect(report?.extra).toEqual({ [state]: 1 });
    });
  }

  it('open states are counted and reported as a warning, with counts only', async () => {
    h.rpc.passkey_account_states = {
      data: [stateRow('no_bridge'), { ...stateRow('bridge_factor_missing'), user_id: 'other' }],
      error: null,
    };
    const s = await runPasskeyMaintenance();
    expect(s.counts).toEqual({ no_bridge: 1, bridge_factor_missing: 1 });
    const report = h.reports.find((r) => r.tag === 'passkeys.accounts_without_verified_bridge');
    expect(report).toMatchObject({
      level: 'warning',
      extra: { no_bridge: 1, bridge_factor_missing: 1 },
    });
    expect(JSON.stringify(h.reports)).not.toContain(U);
  });

  it('an Auth version not on the proven list is reported; with passkeys off it is not checked', async () => {
    h.health = { version: 'v2.199.0' };
    expect((await runPasskeyMaintenance()).authVersion).toBe('unproven');
    expect(h.reports.find((r) => r.tag === 'passkeys.auth_version_unproven')?.extra).toEqual({
      version: 'v2.199.0',
    });

    h.reports = [];
    h.settings = { data: { passkeys_on: false }, error: null };
    expect((await runPasskeyMaintenance()).authVersion).toBe('not_checked');
    expect(tags()).not.toContain('passkeys.auth_version_unproven');
  });

  it('a states read that fails is an error report, and the run still ends normally', async () => {
    h.rpc.passkey_account_states = { data: null, error: { code: '57014' } };
    const s = await runPasskeyMaintenance();
    expect(s.ran).toBe(true);
    expect(tags()).toContain('passkeys.states_unreadable');
  });
});

describe('review 4 finding 10: the upkeep has a time budget and a stop report', () => {
  afterEach(() => vi.useRealTimers());

  it('no new account is started after the budget; the stop is reported with counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rows = Array.from({ length: 3 }, (_, i) =>
      stateRow('reserved_factor_without_row', {
        user_id: `user-${i}`,
        reserved_factors: [{ factor_id: `old-${i}`, status: 'unverified', created_at: ago(60 * MIN) }],
      }),
    );
    h.rpc.passkey_account_states = { data: rows, error: null };
    const { MAINTENANCE_BUDGET_MS } = await import('./passkey-maintenance');
    let deletes = 0;
    const spy = h.deleted;
    // Each account's sweep takes longer than the whole budget.
    const push = spy.push.bind(spy);
    spy.push = (...ids: string[]) => {
      deletes += 1;
      vi.setSystemTime(Date.now() + MAINTENANCE_BUDGET_MS + 1);
      return push(...ids);
    };
    const s = await runPasskeyMaintenance();
    expect(deletes).toBe(1);
    expect(s).toMatchObject({ stop: 'time_limit', accountsSeen: 1, accountsListed: 3 });
    expect(h.reports.find((r) => r.tag === 'passkeys.maintenance_stopped')).toMatchObject({
      level: 'warning',
      extra: { stop: 'time_limit', accountsSeen: 1, accountsListed: 3 },
    });
  });

  it('a run within the budget says nothing about stopping', async () => {
    h.rpc.passkey_account_states = { data: [stateRow('healthy')], error: null };
    const s = await runPasskeyMaintenance();
    expect(s).toMatchObject({ stop: null, accountsSeen: 1, accountsListed: 1 });
    expect(tags()).not.toContain('passkeys.maintenance_stopped');
  });

  it('the comments say four times a day where the code runs four times a day (the retention cron)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.join(__dirname, 'passkey-maintenance.ts'), 'utf8');
    expect(source).not.toMatch(/\bdaily\b|every day/i);
    expect(source).toMatch(/four times a day/);
  });
});
