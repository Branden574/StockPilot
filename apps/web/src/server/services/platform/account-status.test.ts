import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disable state machine. Every assertion here maps to a rule the owner
 * stated: a platform admin can never be disabled (which is also what makes
 * self-disable and last-admin lockout impossible), a reason is mandatory, the
 * transition is compare-and-set so a double click cannot double-audit, and a
 * partial failure heals by pressing the button again.
 *
 * Two things this file guards that the plan did not:
 *
 *   1. The ACTOR is re-checked against the allowlist here, from the VERIFIED
 *      auth email, not from anything the caller passed. The action wrapper does
 *      the step-up; this service must still refuse on its own, because a future
 *      caller that forgets the gate would otherwise have god-mode.
 *   2. The service performs NO broadcast of its own. revokeAllSessionsForUser
 *      already evicts live devices after a successful revoke; a second
 *      broadcast from here would be a duplicate eviction, and the helper is
 *      mocked in this file, so any broadcast seen below could only have come
 *      from the service itself.
 */

const getUserById = vi.fn();
const updateUserById = vi.fn();
// Rest-typed so the pass-through wrappers below spread into them cleanly
// (a zero-arg vi.fn() is not a valid spread target under `tsc --noEmit`).
const revokeAllSessionsForUser = vi.fn(async (..._args: unknown[]) => ({
  ok: true,
  sessionIds: [] as string[],
}));
const broadcastToChannel = vi.fn(async (..._args: unknown[]) => {});
const recordPlatformAudit = vi.fn(async (..._args: unknown[]) => true);
const reportError = vi.fn(async (..._args: unknown[]) => {});

const dbState: {
  update: { data: Array<{ id: string }> | null; error: { message: string } | null };
} = {
  update: { data: [{ id: 'target' }], error: null },
};
const updateArgs: Array<Record<string, unknown>> = [];
const updateSpies: Array<ReturnType<typeof vi.fn>> = [];

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
}));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...a: unknown[]) => revokeAllSessionsForUser(...a),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: (...a: unknown[]) => recordPlatformAudit(...a),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  isPlatformAdmin: (email: string | null | undefined) =>
    typeof email === 'string' && email.toLowerCase() === 'god@stockpilotusa.com',
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById, updateUserById } },
    from: () => {
      const q: Record<string, unknown> = {};
      const update = vi.fn((patch: Record<string, unknown>) => {
        updateArgs.push(patch);
        return q;
      });
      updateSpies.push(update);
      q.update = update;
      q.eq = vi.fn(() => q);
      q.is = vi.fn(() => q);
      q.not = vi.fn(() => q);
      q.select = vi.fn(async () => dbState.update);
      return q;
    },
  }),
}));

import { disableUserAccount, reenableUserAccount } from './account-status';

const TARGET = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR = { actorUserId: ACTOR_ID };
const REASON = { category: 'security_investigation' as const };

/** Auth users the mocked GoTrue admin API knows about, keyed by id. */
const authUsers = new Map<string, { id: string; email: string | null }>();

function primeAuthUsers() {
  authUsers.clear();
  authUsers.set(ACTOR_ID, { id: ACTOR_ID, email: 'god@stockpilotusa.com' });
  authUsers.set(TARGET, { id: TARGET, email: 'worker@acme.test' });
  getUserById.mockImplementation(async (id: string) => {
    const user = authUsers.get(id);
    return user
      ? { data: { user }, error: null }
      : { data: { user: null }, error: { message: 'not found' } };
  });
}

describe('disableUserAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateArgs.length = 0;
    updateSpies.length = 0;
    dbState.update = { data: [{ id: TARGET }], error: null };
    primeAuthUsers();
    updateUserById.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
    revokeAllSessionsForUser.mockResolvedValue({ ok: true, sessionIds: ['s-1', 's-2'] });
    recordPlatformAudit.mockResolvedValue(true);
  });

  it('flags, bans, revokes and audits — in that order', async () => {
    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 2,
      partial: false,
      partialReasons: [],
    });
    expect(updateArgs[0]).toMatchObject({
      disabled_reason: 'Security investigation',
      disabled_by: ACTOR_ID,
    });
    expect(typeof updateArgs[0]!.disabled_at).toBe('string');
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: '876000h' });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user_disabled',
        targetUserId: TARGET,
        // The audit's actor email is the VERIFIED one, resolved here from the
        // actor id — never a caller-supplied string.
        actorEmail: 'god@stockpilotusa.com',
      }),
    );

    // Layer A (the flag every request chokepoint reads) lands before Layer B
    // and before revocation, so a crash anywhere leaves the account locked out
    // rather than half-open. The audit is last: it describes what happened.
    const cas = updateSpies[0]!.mock.invocationCallOrder[0]!;
    expect(cas).toBeLessThan(updateUserById.mock.invocationCallOrder[0]!);
    expect(updateUserById.mock.invocationCallOrder[0]!).toBeLessThan(
      revokeAllSessionsForUser.mock.invocationCallOrder[0]!,
    );
    expect(revokeAllSessionsForUser.mock.invocationCallOrder[0]!).toBeLessThan(
      recordPlatformAudit.mock.invocationCallOrder[0]!,
    );
  });

  it('never broadcasts itself — the revoke helper owns the one eviction', async () => {
    await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    // revokeAllSessionsForUser is mocked, so it cannot have broadcast. A call
    // here would be a SECOND eviction emitted by this service — the duplicate
    // the Task 3 review removed.
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('NEVER lets the reason leave the service', async () => {
    await disableUserAccount({
      targetUserId: TARGET,
      reason: { category: 'other', notes: 'Suspected credential sharing' },
      ...ACTOR,
    });

    // The eviction channel is PUBLIC. The helper is handed a bare user id and
    // nothing else, and nothing at all is broadcast from here, so the reason
    // cannot reach a subscriber.
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect(JSON.stringify(revokeAllSessionsForUser.mock.calls)).not.toContain('Suspected');
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('refuses an allowlisted platform admin BEFORE writing anything', async () => {
    authUsers.set(TARGET, { id: TARGET, email: 'God@StockPilotUSA.com' });

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' });
    expect(updateArgs).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('refuses an actor who is not on the allowlist, before writing anything', async () => {
    authUsers.set(ACTOR_ID, { id: ACTOR_ID, email: 'manager@acme.test' });

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({ ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' });
    expect(updateArgs).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses an actor whose auth user no longer exists', async () => {
    authUsers.delete(ACTOR_ID);

    expect(await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
    });
    expect(updateArgs).toHaveLength(0);
  });

  it('refuses an empty reason', async () => {
    const res = await disableUserAccount({
      targetUserId: TARGET,
      reason: { category: 'other', notes: '   ' },
      ...ACTOR,
    });

    expect(res).toEqual({ ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' });
    expect(updateArgs).toHaveLength(0);
  });

  it('refuses a note longer than the shared schema allows', async () => {
    const res = await disableUserAccount({
      targetUserId: TARGET,
      reason: { category: 'other', notes: 'x'.repeat(501) },
      ...ACTOR,
    });

    expect(res).toEqual({ ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' });
    expect(updateArgs).toHaveLength(0);
  });

  it('returns ACCOUNT_NOT_FOUND when the auth user is gone', async () => {
    authUsers.delete(TARGET);

    expect(await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('is idempotent: a CAS miss re-bans, re-revokes AND re-attempts the audit row', async () => {
    dbState.update = { data: [], error: null };

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toMatchObject({ ok: true, alreadyDisabled: true, banned: true, sessionsRevoked: 2 });
    // The audit write used to be SKIPPED here ("the original press wrote the
    // row"). That assumption is what made a lost audit row permanent: the
    // operator was told to press Disable again, the retry never re-attempted
    // the write, and the second press reported clean success with no row.
    // Pressing Disable on an already-disabled account re-asserts the same
    // action, so recording it is correct.
    expect(recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
  });

  it('marks the replayed audit row as a replay, so it cannot imply a fresh transition', async () => {
    dbState.update = { data: [], error: null };

    await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    // On a replay the CAS wrote nothing, so `reason` is what THIS operator
    // typed, not what is stored on the profile. The row says so.
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user_disabled',
        detail: expect.objectContaining({ already_disabled: true }),
      }),
    );
  });

  it('fails CLOSED on a ban error: the flag stays set and the caller is told it is partial', async () => {
    updateUserById.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toMatchObject({
      ok: true,
      banned: false,
      partial: true,
      partialReasons: ['ban_not_applied'],
    });
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalled();
  });

  it('reports partial when the revoke failed even though the ban landed', async () => {
    revokeAllSessionsForUser.mockResolvedValue({ ok: false, sessionIds: [] });

    expect(await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR })).toEqual({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 0,
      partial: true,
      partialReasons: ['sessions_not_revoked'],
    });
  });

  it('reports partial when the account was disabled but the audit row did NOT land', async () => {
    recordPlatformAudit.mockResolvedValue(false);

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    // The disable is NOT rolled back — the user must stay locked out — but the
    // owner's "every disable is auditable" guarantee is broken for this row, so
    // the caller is told, distinctly, rather than being handed a clean success.
    expect(res).toEqual({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 2,
      partial: true,
      partialReasons: ['not_audited'],
    });
  });

  it('reports a replay as clean only when the re-attempted audit row landed', async () => {
    dbState.update = { data: [], error: null };

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toMatchObject({ alreadyDisabled: true, partial: false, partialReasons: [] });
    expect(recordPlatformAudit).toHaveBeenCalledTimes(1);
  });

  it('a replay whose audit write ALSO fails stays partial — it never launders into success', async () => {
    dbState.update = { data: [], error: null };
    recordPlatformAudit.mockResolvedValue(false);

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    // This is the exact laundering the review caught: press one returns
    // ['ban_not_applied','not_audited'], the operator presses again, and the
    // retry used to force audited=true and hand back a clean success with the
    // user_disabled row permanently missing.
    expect(res).toMatchObject({
      ok: true,
      alreadyDisabled: true,
      partial: true,
      partialReasons: ['not_audited'],
    });
  });

  it('collects every failed layer, not just the first', async () => {
    updateUserById.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });
    revokeAllSessionsForUser.mockResolvedValue({ ok: false, sessionIds: [] });
    recordPlatformAudit.mockResolvedValue(false);

    expect(await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR })).toMatchObject(
      { partial: true, partialReasons: ['ban_not_applied', 'sessions_not_revoked', 'not_audited'] },
    );
  });

  it('calls a lost CAS write a CONCURRENT CHANGE, never a permission problem', async () => {
    dbState.update = { data: null, error: { message: 'deadlock detected' } };

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    // The actor was already verified against the allowlist above, so a failure
    // at the write can never be an authorization failure. Telling the operator
    // they lack permission would be a lie; the honest instruction is "the
    // status just moved, reload and try again".
    expect(res).toEqual({ ok: false, code: 'ACCOUNT_STATUS_CHANGED' });
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('reenableUserAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateArgs.length = 0;
    updateSpies.length = 0;
    dbState.update = { data: [{ id: TARGET }], error: null };
    primeAuthUsers();
    updateUserById.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
    recordPlatformAudit.mockResolvedValue(true);
  });

  it('clears all three columns, lifts the ban and audits', async () => {
    const res = await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(res).toEqual({
      ok: true,
      alreadyActive: false,
      banned: false,
      partial: false,
      partialReasons: [],
    });
    expect(updateArgs[0]).toEqual({ disabled_at: null, disabled_reason: null, disabled_by: null });
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: 'none' });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user_reenabled',
        targetUserId: TARGET,
        actorEmail: 'god@stockpilotusa.com',
      }),
    );
  });

  it('heals a stray ban on a CAS miss, lifts the ban, and re-attempts the audit row', async () => {
    dbState.update = { data: [], error: null };

    const res = await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(res).toMatchObject({ ok: true, alreadyActive: true });
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: 'none' });
    // Same reasoning as the disable path: the retry the operator is told to
    // perform must actually be able to write the row it is retrying for.
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user_reenabled',
        detail: expect.objectContaining({ already_active: true }),
      }),
    );
  });

  it('a replayed re-enable whose audit ALSO fails stays partial', async () => {
    dbState.update = { data: [], error: null };
    recordPlatformAudit.mockResolvedValue(false);

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toMatchObject({
      ok: true,
      alreadyActive: true,
      partial: true,
      partialReasons: ['not_audited'],
    });
  });

  it('never revokes sessions or broadcasts — re-enable only grants access', async () => {
    await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('refuses an actor who is not on the allowlist', async () => {
    authUsers.set(ACTOR_ID, { id: ACTOR_ID, email: 'manager@acme.test' });

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
    });
    expect(updateArgs).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_NOT_FOUND when the auth user is gone', async () => {
    authUsers.delete(TARGET);

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('reports partial when the ban could not be lifted', async () => {
    updateUserById.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toEqual({
      ok: true,
      alreadyActive: false,
      banned: true,
      partial: true,
      partialReasons: ['ban_not_lifted'],
    });
    expect(reportError).toHaveBeenCalled();
  });

  it('reports partial when the re-enable landed but the audit row did NOT', async () => {
    recordPlatformAudit.mockResolvedValue(false);

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toEqual({
      ok: true,
      alreadyActive: false,
      banned: false,
      partial: true,
      partialReasons: ['not_audited'],
    });
  });

  it('calls a lost CAS write a CONCURRENT CHANGE, never a permission problem', async () => {
    dbState.update = { data: null, error: { message: 'could not serialize access' } };

    expect(await reenableUserAccount({ targetUserId: TARGET, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_STATUS_CHANGED',
    });
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

/**
 * Source-level twin of the "no second broadcast" assertions above: the mock
 * proves the current code path is clean, this proves nobody can re-introduce
 * the duplicate on a branch the tests do not reach.
 */
describe('the eviction broadcast lives in ONE place', () => {
  const src = readFileSync(join(__dirname, 'account-status.ts'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('account-status.ts never calls broadcastToChannel', () => {
    expect(code).not.toContain('broadcastToChannel');
  });

  it('the only tables account-status.ts writes are user_profiles and the audit', () => {
    // Regression R2: a disable must not touch memberships, assignments or any
    // operational table. Everything else this service writes goes through the
    // GoTrue admin API (auth.users), the 0308 RPC (auth.sessions) and
    // recordPlatformAudit (platform_admin_audit) — never a `.from()` here.
    const tables = [...code.matchAll(/\.from\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(['user_profiles']);
  });
});
