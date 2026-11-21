import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision B (2026-11-21): one last-method rule for authenticator apps and
 * passkeys. The LAST second-step method cannot be removed while a policy of
 * an organization the member belongs to requires one; one of two may go.
 * Apps counted: verified TOTP factors without the reserved bridge name.
 * Passkeys counted: active rows of this site. Strict on doubt. Reads only
 * what it needs. The service-role client is a fake that applies the filters
 * it is given and records every read.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rp: { rpId: 'localhost', origins: ['http://localhost:3000'] } as {
    rpId: string;
    origins: string[];
  } | null,
  passkeys: [] as Row[],
  memberships: [] as Row[],
  organizations: [] as Row[],
  fail: new Set<string>(),
  reads: [] as string[],
  clients: 0,
}));

vi.mock('@/lib/auth/passkey-relying-party', () => ({ passkeyRelyingParty: () => h.rp }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.clients += 1;
    return {
      from: (table: string) => {
        h.reads.push(table);
        const filters: Array<(r: Row) => boolean> = [];
        let single = false;
        const rows = () =>
          table === 'member_passkeys'
            ? h.passkeys
            : table === 'organization_members'
              ? h.memberships
              : h.organizations;
        const answer = () => {
          if (h.fail.has(table)) return { data: null, error: { code: '57014' } };
          const out = rows().filter((r) => filters.every((f) => f(r)));
          return { data: single ? (out[0] ?? null) : out, error: null };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), q),
          not: (c: string) => (filters.push((r) => (r[c] ?? null) !== null), q),
          limit: () => q,
          maybeSingle: async () => ((single = true), answer()),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve),
        };
        return q;
      },
    };
  },
}));

import { LAST_METHOD_WORDS, lastMethodBlocks, secondStepRequired } from './second-step-methods';

const U = 'user-1';
const app = (id: string, extra: Row = {}) => ({
  id,
  factor_type: 'totp',
  status: 'verified',
  friendly_name: 'Phone',
  ...extra,
});
const BRIDGE = app('bridge-1', { friendly_name: 'sp-passkey-bridge-a1b2c3d4e5f6' });
const passkey = (id: string, extra: Row = {}) => ({
  id,
  user_id: U,
  rp_id: 'localhost',
  removed_at: null,
  ...extra,
});
function member(policy: string, role = 'staff', extra: Row = {}) {
  const org = `org-${h.organizations.length + 1}`;
  h.organizations.push({ id: org, mfa_policy: policy });
  h.memberships.push({
    user_id: U,
    organization_id: org,
    role,
    accepted_at: '2026-11-01T00:00:00Z',
    impersonation_expires_at: null,
    ...extra,
  });
}

beforeEach(() => {
  h.rp = { rpId: 'localhost', origins: ['http://localhost:3000'] };
  h.passkeys = [];
  h.memberships = [];
  h.organizations = [];
  h.fail = new Set();
  h.reads = [];
  h.clients = 0;
});

describe('decision B: the last-method rule', () => {
  it('one plain sentence for both kinds', () => {
    expect(LAST_METHOD_WORDS).toBe(
      'Your organization requires a second step. Add another authenticator app or passkey before you remove this one.',
    );
  });

  it('one of two apps may go under a requiring policy, with no read at all', async () => {
    member('all_required');
    const blocks = await lastMethodBlocks({
      userId: U,
      removing: { kind: 'app', factorId: 'a' },
      factors: [app('a'), app('b')],
    });
    expect(blocks).toBe(false);
    expect(h.clients).toBe(0);
  });

  it('removing a factor that is no method (unverified, or not listed) never blocks', async () => {
    member('all_required');
    for (const factors of [[app('a', { status: 'unverified' })], [app('b')]]) {
      expect(
        await lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors }),
      ).toBe(false);
    }
  });

  it('the last app: an active passkey of this site keeps a second step (one read, the policy never asked)', async () => {
    member('all_required');
    h.passkeys = [passkey('p1')];
    const blocks = await lastMethodBlocks({
      userId: U,
      removing: { kind: 'app', factorId: 'a' },
      factors: [app('a'), BRIDGE],
    });
    expect(blocks).toBe(false);
    expect(h.reads).toEqual(['member_passkeys']);
  });

  it('the last app: a removed passkey, another site\'s, or another account\'s keeps nothing', async () => {
    member('all_required');
    h.passkeys = [
      passkey('p1', { removed_at: '2026-11-20T00:00:00Z' }),
      passkey('p2', { rp_id: 'other.example.test' }),
      passkey('p3', { user_id: 'user-2' }),
    ];
    expect(
      await lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors: [app('a')] }),
    ).toBe(true);
  });

  it('the bridge is never an app: a passkey whose only other factor is its bridge is the last method', async () => {
    member('all_required');
    expect(
      await lastMethodBlocks({
        userId: U,
        removing: { kind: 'passkey', passkeyId: 'p1' },
        factors: [BRIDGE],
        passkeyIds: ['p1'],
      }),
    ).toBe(true);
  });

  it('a passkey beside an app, or beside another passkey, may go', async () => {
    member('all_required');
    for (const [factors, passkeyIds] of [
      [[app('a'), BRIDGE], ['p1']],
      [[BRIDGE], ['p1', 'p2']],
    ] as const) {
      expect(
        await lastMethodBlocks({
          userId: U,
          removing: { kind: 'passkey', passkeyId: 'p1' },
          factors,
          passkeyIds,
        }),
      ).toBe(false);
    }
  });

  it('the last method: refused under all_required, and under admins_required for an owner or admin only', async () => {
    const lastApp = () =>
      lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors: [app('a')] });
    expect(await lastApp()).toBe(false);
    member('optional', 'owner');
    expect(await lastApp()).toBe(false);
    member('admins_required', 'staff');
    expect(await lastApp()).toBe(false);
    member('admins_required', 'admin');
    expect(await lastApp()).toBe(true);
    h.memberships = [];
    h.organizations = [];
    member('all_required', 'staff');
    expect(await lastApp()).toBe(true);
  });

  it('any organization of the member counts, not only the active one; an act-as seat and an invitation do not', async () => {
    member('optional', 'owner');
    member('all_required', 'owner', { impersonation_expires_at: '2026-12-01T00:00:00Z' });
    member('all_required', 'owner', { accepted_at: null });
    const lastApp = () =>
      lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors: [app('a')] });
    expect(await lastApp()).toBe(false);
    member('all_required', 'staff');
    expect(await lastApp()).toBe(true);
  });

  it('a policy the caller already read as requiring: refused with no policy read', async () => {
    const blocks = await lastMethodBlocks({
      userId: U,
      removing: { kind: 'app', factorId: 'a' },
      factors: [app('a')],
      requiredKnown: true,
    });
    expect(blocks).toBe(true);
    expect(h.reads).toEqual(['member_passkeys']);
  });

  it('strict on doubt: an unread factor list or passkey list is the last method; only the policy then decides', async () => {
    const unknownApps = () =>
      lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors: null });
    expect(await unknownApps()).toBe(false);
    member('all_required');
    expect(await unknownApps()).toBe(true);
    h.passkeys = [passkey('p1')];
    expect(await unknownApps()).toBe(false);
    h.fail.add('member_passkeys');
    expect(await unknownApps()).toBe(true);
  });

  it('strict on doubt: memberships or a policy that cannot be read, or an organization row hidden, require', async () => {
    member('optional');
    const admin = (await import('@/lib/supabase/admin')).createAdminClient();
    expect(await secondStepRequired(admin, U)).toBe(false);
    h.fail.add('organization_members');
    expect(await secondStepRequired(admin, U)).toBe(true);
    h.fail = new Set(['organizations']);
    expect(await secondStepRequired(admin, U)).toBe(true);
    h.fail = new Set();
    h.organizations = [];
    expect(await secondStepRequired(admin, U)).toBe(true);
  });

  it('with no site no passkey can serve here: none is counted, and none is read', async () => {
    h.rp = null;
    h.passkeys = [passkey('p1')];
    member('all_required');
    expect(
      await lastMethodBlocks({ userId: U, removing: { kind: 'app', factorId: 'a' }, factors: [app('a')] }),
    ).toBe(true);
    expect(h.reads).not.toContain('member_passkeys');
  });
});
