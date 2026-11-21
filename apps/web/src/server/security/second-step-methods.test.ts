import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision B (2026-11-21): one last-method rule for authenticator apps and
 * passkeys. The LAST second-step method cannot be removed while a policy of
 * an organization the member belongs to requires one; one of two may go.
 *
 * With the integrator's two corrections of the same day:
 *   1. A passkey counts only when it can actually serve as the second step
 *      (the caller's judgement: the second-step page's own, in
 *      server/security/passkeys.ts servingPasskeyIds). A row alone is not a
 *      method.
 *   2. Unknown is never fine. An unknown app count (the factor list unread,
 *      or another account's) never lets the passkeys answer "allowed"; a
 *      passkey judgement that could not be made, or a policy that could not
 *      be read, answers "try again" wherever a requiring policy could hold.
 *
 * Apps counted: verified TOTP factors without the reserved bridge name. The
 * service-role client is a fake that applies the filters it is given and
 * records every read; the passkey judgement is a spy.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  memberships: [] as Row[],
  organizations: [] as Row[],
  fail: new Set<string>(),
  reads: [] as string[],
  clients: 0,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.clients += 1;
    return {
      from: (table: string) => {
        h.reads.push(table);
        const filters: Array<(r: Row) => boolean> = [];
        let single = false;
        const rows = () => (table === 'organization_members' ? h.memberships : h.organizations);
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

import { FACTOR_CHECK_RETRY } from '@/lib/auth/passkey-bridge';

import {
  LAST_METHOD_RETRY_WORDS,
  LAST_METHOD_WORDS,
  lastMethodVerdict,
  secondStepPolicy,
  type RemovingMethod,
} from './second-step-methods';

const U = 'user-1';
const app = (id: string, extra: Row = {}) => ({
  id,
  factor_type: 'totp',
  status: 'verified',
  friendly_name: 'Phone',
  ...extra,
});
const BRIDGE = app('bridge-1', { friendly_name: 'sp-passkey-bridge-a1b2c3d4e5f6' });
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

/** The caller's passkey judgement as a spy: the ids that can serve, null (could not tell), or a throw. */
function serving(answer: ReadonlyArray<string> | null | Error) {
  return vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

const APP_A: RemovingMethod = { kind: 'app', factorId: 'a' };
const passkeyOf = (id: string): RemovingMethod => ({ kind: 'passkey', passkeyId: id });

function verdict(
  removing: RemovingMethod,
  factors: ReadonlyArray<Row> | null,
  servingPasskeys = serving([]),
  requiredKnown?: boolean,
) {
  return lastMethodVerdict({ userId: U, removing, factors, servingPasskeys, requiredKnown });
}

beforeEach(() => {
  h.memberships = [];
  h.organizations = [];
  h.fail = new Set();
  h.reads = [];
  h.clients = 0;
});

describe('decision B: the last-method rule', () => {
  it('one plain sentence for both kinds, and one retry sentence (the bridge check\'s own)', () => {
    expect(LAST_METHOD_WORDS).toBe(
      'Your organization requires a second step. Add another authenticator app or passkey before you remove this one.',
    );
    expect(LAST_METHOD_RETRY_WORDS).toBe(FACTOR_CHECK_RETRY);
  });

  it('one of two apps may go under a requiring policy: nothing read, the passkeys never asked', async () => {
    member('all_required');
    const passkeys = serving(['p1']);
    expect(await verdict(APP_A, [app('a'), app('b')], passkeys)).toBe('allowed');
    expect(passkeys).not.toHaveBeenCalled();
    expect(h.clients).toBe(0);
  });

  it('removing a factor that is no method (unverified, not listed, the reserved name) never blocks', async () => {
    member('all_required');
    for (const factors of [
      [app('a', { status: 'unverified' })],
      [app('b')],
      [app('a', { friendly_name: 'sp-passkey-bridge-0123456789ab' })],
    ]) {
      const passkeys = serving([]);
      expect(await verdict(APP_A, factors, passkeys)).toBe('allowed');
      expect(passkeys).not.toHaveBeenCalled();
    }
    expect(h.clients).toBe(0);
  });

  it('the last app beside a passkey that can serve may go; the policy is never read', async () => {
    member('all_required');
    const passkeys = serving(['p1']);
    expect(await verdict(APP_A, [app('a'), BRIDGE], passkeys)).toBe('allowed');
    expect(passkeys).toHaveBeenCalledOnce();
    expect(h.reads).toEqual([]);
  });

  it('correction 1: the last app while the passkeys cannot serve is refused under a requiring policy', async () => {
    member('all_required');
    // The member has passkey rows, but the caller judged that none can serve
    // (no verified bridge, the switch off, a secret that does not open).
    expect(await verdict(APP_A, [app('a'), BRIDGE], serving([]))).toBe('last_method');
    expect(await verdict(APP_A, [app('a'), { ...BRIDGE, status: 'unverified' }], serving([]))).toBe(
      'last_method',
    );
  });

  it('a passkey beside an app (the passkeys never asked), or beside another passkey that can serve, may go', async () => {
    member('all_required');
    const unasked = serving(['p1']);
    expect(await verdict(passkeyOf('p1'), [app('a'), BRIDGE], unasked)).toBe('allowed');
    expect(unasked).not.toHaveBeenCalled();
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving(['p1', 'p2']))).toBe('allowed');
  });

  it('the last passkey that can serve is refused; a passkey that cannot serve is no method, and may go', async () => {
    member('all_required');
    // The bridge alone (a verified reserved-name factor) is never an app.
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving(['p1']))).toBe('last_method');
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving([]))).toBe('allowed');
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving(['p2']))).toBe('allowed');
  });

  it('the last method: refused under all_required, and under admins_required for an owner or admin only', async () => {
    const lastApp = () => verdict(APP_A, [app('a')]);
    expect(await lastApp()).toBe('allowed');
    member('optional', 'owner');
    expect(await lastApp()).toBe('allowed');
    member('admins_required', 'staff');
    expect(await lastApp()).toBe('allowed');
    member('admins_required', 'admin');
    expect(await lastApp()).toBe('last_method');
    h.memberships = [];
    h.organizations = [];
    member('all_required', 'staff');
    expect(await lastApp()).toBe('last_method');
  });

  it('any organization of the member counts, not only the active one; an act-as seat and an invitation do not', async () => {
    member('optional', 'owner');
    member('all_required', 'owner', { impersonation_expires_at: '2026-12-01T00:00:00Z' });
    member('all_required', 'owner', { accepted_at: null });
    const lastApp = () => verdict(APP_A, [app('a')]);
    expect(await lastApp()).toBe('allowed');
    member('all_required', 'staff');
    expect(await lastApp()).toBe('last_method');
  });

  it('a policy the caller already read as requiring: refused with no policy read', async () => {
    expect(await verdict(APP_A, [app('a')], serving([]), true)).toBe('last_method');
    expect(h.reads).toEqual([]);
  });
});

describe('correction 2: unknown is never fine', () => {
  it('an unknown factor list (unread, or another account\'s): the passkeys are never asked, and a requiring policy answers try again', async () => {
    member('all_required');
    for (const removing of [APP_A, passkeyOf('p1')]) {
      const passkeys = serving(['p1', 'p2']);
      expect(await verdict(removing, null, passkeys)).toBe('unreadable');
      expect(passkeys).not.toHaveBeenCalled();
    }
    expect(await verdict(APP_A, null, serving(['p1']), true)).toBe('unreadable');
  });

  it('an unknown factor list where no policy requires a second step: allowed (the rule holds only under a requiring policy)', async () => {
    expect(await verdict(APP_A, null)).toBe('allowed');
    member('optional', 'owner');
    member('admins_required', 'staff');
    expect(await verdict(APP_A, null)).toBe('allowed');
  });

  it('a passkey judgement that could not be made (a read failed, the switch unread, a throw): try again, never allowed', async () => {
    member('all_required');
    expect(await verdict(APP_A, [app('a')], serving(null))).toBe('unreadable');
    expect(await verdict(APP_A, [app('a')], serving(new Error('sample-read-failure')))).toBe(
      'unreadable',
    );
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving(null))).toBe('unreadable');
    expect(await verdict(APP_A, [app('a')], serving(null), true)).toBe('unreadable');
  });

  it('a passkey judgement that could not be made where no policy requires one: allowed', async () => {
    member('optional', 'owner');
    expect(await verdict(APP_A, [app('a')], serving(null))).toBe('allowed');
    expect(await verdict(passkeyOf('p1'), [BRIDGE], serving(null))).toBe('allowed');
  });

  it('a policy that cannot be read (memberships, an organization, a missing organization row): try again, never allowed', async () => {
    member('optional');
    const lastApp = () => verdict(APP_A, [app('a')]);
    expect(await lastApp()).toBe('allowed');
    h.fail = new Set(['organization_members']);
    expect(await lastApp()).toBe('unreadable');
    h.fail = new Set(['organizations']);
    expect(await lastApp()).toBe('unreadable');
    h.fail = new Set();
    h.organizations = [];
    expect(await lastApp()).toBe('unreadable');
  });

  it('one organization unread and another that requires: refused with the rule\'s own words', async () => {
    member('optional');
    member('all_required');
    // The first organization's row is gone (read as nothing): unread.
    h.organizations = h.organizations.filter((o) => o.id !== 'org-1');
    expect(await verdict(APP_A, [app('a')])).toBe('last_method');
    h.organizations = h.organizations.filter((o) => o.id !== 'org-2');
    expect(await verdict(APP_A, [app('a')])).toBe('unreadable');
  });
});

describe('secondStepPolicy: required, not required, or unreadable', () => {
  it('answers each, strict on an unknown policy word', async () => {
    const admin = (await import('@/lib/supabase/admin')).createAdminClient();
    expect(await secondStepPolicy(admin, U)).toBe('not_required');
    member('optional');
    expect(await secondStepPolicy(admin, U)).toBe('not_required');
    member('sample-new-policy-word');
    expect(await secondStepPolicy(admin, U)).toBe('required');
    h.memberships = [];
    h.organizations = [];
    member('optional');
    h.fail = new Set(['organization_members']);
    expect(await secondStepPolicy(admin, U)).toBe('unreadable');
    h.fail = new Set(['organizations']);
    expect(await secondStepPolicy(admin, U)).toBe('unreadable');
    h.fail = new Set();
    h.organizations = [];
    expect(await secondStepPolicy(admin, U)).toBe('unreadable');
  });
});
