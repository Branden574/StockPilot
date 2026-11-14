import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * "Act as this org": the reads and the grant delete that decide what start,
 * stop and the sweep write next. A read that answers an error is never read as
 * "no organization", "not a member", "no previous organization" or "no session
 * to end": start and stop write nothing more (the action reports it and shows
 * its sentence). A grant delete that fails ends no session, so a later sweep
 * tries it again.
 */

const { recordPlatformAudit, reportError } = vi.hoisted(() => ({
  recordPlatformAudit: vi.fn(async (_row: unknown) => {}),
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('./audit', () => ({ recordPlatformAudit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const ORG_ID = '0a000000-0000-4000-8000-000000000002';
const PREVIOUS_ORG_ID = '0a000000-0000-4000-8000-000000000003';
const OTHER_ORG_ID = '0a000000-0000-4000-8000-000000000004';
const READ_FAILED = { message: 'canceling statement due to statement timeout', code: '57014' };

/** What each read answers in a test, and the organizations whose grant delete fails. */
const answers: {
  expired: QueryResult;
  activeSession: QueryResult;
  org: QueryResult;
  membership: QueryResult;
  profile: QueryResult;
  grantWrite: QueryResult;
  grantDeleteFailsFor: string[];
} = {
  expired: { data: [], error: null },
  activeSession: { data: null, error: null },
  org: { data: null, error: null },
  membership: { data: null, error: null },
  profile: { data: null, error: null },
  grantWrite: { data: null, error: null },
  grantDeleteFailsFor: [],
};

/** Every read and write the stub answered, as "table.op", in the order they ran. */
let ran: string[] = [];

let stub = makeStub();

/** The value of the chain's `.eq(column, value)` filter. */
function eqValue(call: MockCall, column: string): unknown {
  const i = call.methods.findIndex((m, n) => m === 'eq' && call.args[n]?.[0] === column);
  return i === -1 ? undefined : call.args[i]?.[1];
}

/** Logs each answered call in `ran`, then answers it as given. */
function logged(
  results: Record<string, QueryResult | ((call: MockCall) => QueryResult)>,
): Record<string, (call: MockCall) => QueryResult> {
  return Object.fromEntries(
    Object.entries(results).map(([key, result]) => [
      key,
      (call: MockCall) => {
        ran.push(`${call.table}.${call.op}`);
        return typeof result === 'function' ? result(call) : result;
      },
    ]),
  );
}

function makeStub() {
  ran = [];
  return makeSupabaseStub(logged({
    'platform_impersonation_sessions.select': (call: MockCall) =>
      // The sweep's expired sessions (`.lt('expires_at', now)`), else the active one.
      call.methods.includes('lt') ? answers.expired : answers.activeSession,
    'platform_impersonation_sessions.insert': { data: null, error: null },
    'platform_impersonation_sessions.update': { data: null, error: null },
    'organizations.select': () => answers.org,
    'organization_members.select': () => answers.membership,
    'organization_members.insert': () => answers.grantWrite,
    'organization_members.delete': (call: MockCall) =>
      answers.grantDeleteFailsFor.includes(eqValue(call, 'organization_id') as string)
        ? { data: null, error: READ_FAILED }
        : { data: null, error: null },
    'user_profiles.select': () => answers.profile,
    'user_profiles.update': { data: null, error: null },
  }));
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => stub.client,
}));

import { startActingAs, stopActingAs, sweepExpiredImpersonations } from './impersonation';

/** Every write the stub saw, as "table.op". */
function writes(): string[] {
  return [...stub.chainsAll.keys()].filter((k) => !k.endsWith('.select'));
}

/** The session ids the stub saw ended. */
function endedSessions(): unknown[] {
  return (stub.chainArgsAll.get('platform_impersonation_sessions.update') ?? []).map(
    (args) => args.find((a, n) => n > 0 && a[0] === 'id')?.[1],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeStub();
  answers.expired = { data: [], error: null };
  answers.activeSession = { data: null, error: null };
  answers.org = { data: { id: ORG_ID, name: 'Example Org' }, error: null };
  answers.membership = { data: null, error: null };
  answers.profile = { data: { default_organization_id: PREVIOUS_ORG_ID }, error: null };
  answers.grantWrite = { data: null, error: null };
  answers.grantDeleteFailsFor = [];
});

const START = { adminUserId: ADMIN_ID, adminEmail: 'ops@example.test', organizationId: ORG_ID, now: 1_000 };
const STOP = { adminUserId: ADMIN_ID, adminEmail: 'ops@example.test' };
const ACTIVE = {
  data: { id: 's-1', target_organization_id: ORG_ID, previous_organization_id: PREVIOUS_ORG_ID },
  error: null,
};

const EXPIRED = {
  data: [
    {
      id: 's-0',
      admin_user_id: ADMIN_ID,
      target_organization_id: OTHER_ORG_ID,
      previous_organization_id: PREVIOUS_ORG_ID,
    },
  ],
  error: null,
};
const EARLIER = {
  data: { id: 's-1', target_organization_id: OTHER_ORG_ID, previous_organization_id: PREVIOUS_ORG_ID },
  error: null,
};

describe('startActingAs reads the organization before anything else', () => {
  it('with an earlier session open, an organization read that fails writes nothing at all', async () => {
    answers.expired = EXPIRED;
    answers.activeSession = EARLIER;
    answers.org = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).resolves.toEqual({ ok: false, reason: 'org_unreadable' });
    expect(writes()).toEqual([]);
    expect(endedSessions()).toEqual([]);
    expect(ran).toEqual(['organizations.select']);
  });

  it('with an earlier session open, an unknown organization ends nobody\'s session', async () => {
    answers.expired = EXPIRED;
    answers.activeSession = EARLIER;
    answers.org = { data: null, error: null };
    await expect(startActingAs(START)).resolves.toEqual({ ok: false, reason: 'org_not_found' });
    expect(writes()).toEqual([]);
    expect(ran).toEqual(['organizations.select']);
  });

  it('the healthy path writes the same things in the same order, after the organization read', async () => {
    answers.expired = EXPIRED;
    answers.activeSession = EARLIER;
    await expect(startActingAs(START)).resolves.toEqual({ ok: true, alreadyMember: false });
    expect(ran[0]).toBe('organizations.select');
    expect(ran.filter((r) => !r.endsWith('.select'))).toEqual([
      // The sweep of the expired session: restore, grant delete, session end.
      'user_profiles.update',
      'organization_members.delete',
      'platform_impersonation_sessions.update',
      // The silent stop of the earlier session: grant delete, restore, session end.
      'organization_members.delete',
      'user_profiles.update',
      'platform_impersonation_sessions.update',
      // The new grant (an upsert), the session, the switch.
      'organization_members.insert',
      'platform_impersonation_sessions.insert',
      'user_profiles.update',
    ]);
    expect(endedSessions()).toEqual(['s-0', 's-1']);
  });
});

describe('startActingAs', () => {
  it('writes nothing when the earlier session could not be read', async () => {
    answers.activeSession = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).rejects.toThrow(/session/);
    expect(writes()).toEqual([]);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('writes nothing and says so when the organization could not be read', async () => {
    answers.org = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).resolves.toEqual({ ok: false, reason: 'org_unreadable' });
    expect(writes()).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform.impersonation.org-read' }),
    );
  });

  it('an organization that does not exist is not found', async () => {
    answers.org = { data: null, error: null };
    await expect(startActingAs(START)).resolves.toEqual({ ok: false, reason: 'org_not_found' });
    expect(writes()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('writes nothing when the admin membership in the organization could not be read', async () => {
    answers.membership = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).rejects.toThrow(/membership/);
    expect(writes()).toEqual([]);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('writes nothing when the admin active organization could not be read', async () => {
    answers.profile = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).rejects.toThrow(/profile/);
    expect(writes()).toEqual([]);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('a real member gets no temporary grant, only the switch', async () => {
    answers.membership = { data: { id: 'm-1', impersonation_expires_at: null }, error: null };
    await expect(startActingAs(START)).resolves.toEqual({ ok: true, alreadyMember: true });
    expect(stub.chainsAll.get('organization_members.insert')).toBeUndefined();
    expect(stub.chainArgs.get('platform_impersonation_sessions.insert')?.[0]?.[0]).toMatchObject({
      previous_organization_id: PREVIOUS_ORG_ID,
    });
  });

  // Migration 0458: the grant's upsert can land on the admin's own real
  // owner row (a membership that appeared after the read above). The database
  // then refuses at commit when that row was the organization's only owner
  // and other members remain, or answers busy. No session is recorded and the
  // admin's organization is not switched.
  it.each([
    { raised: { code: 'P0001', message: 'organization_needs_owner' }, reason: 'only_owner' },
    { raised: { code: '55P03', message: 'organization_owner_check_busy' }, reason: 'owner_check_busy' },
  ])('the owner rule "$raised.message" on the grant: $reason, nothing after it', async ({ raised, reason }) => {
    answers.grantWrite = { data: null, error: raised };
    await expect(startActingAs(START)).resolves.toEqual({ ok: false, reason });
    expect(stub.chainsAll.get('platform_impersonation_sessions.insert')).toBeUndefined();
    expect(stub.chainsAll.get('user_profiles.update')).toBeUndefined();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('any other grant failure still throws', async () => {
    answers.grantWrite = { data: null, error: READ_FAILED };
    await expect(startActingAs(START)).rejects.toThrow(/impersonation grant/);
  });

  it('a non-member gets the temporary owner grant', async () => {
    await expect(startActingAs(START)).resolves.toEqual({ ok: true, alreadyMember: false });
    expect(stub.chainArgs.get('organization_members.insert')?.[0]?.[0]).toMatchObject({
      organization_id: ORG_ID,
      user_id: ADMIN_ID,
      role: 'owner',
    });
  });
});

describe('stopActingAs', () => {
  it('ends nothing and throws when the active session could not be read', async () => {
    answers.activeSession = { data: null, error: READ_FAILED };
    await expect(stopActingAs(STOP)).rejects.toThrow(/session/);
    expect(writes()).toEqual([]);
  });

  it('with no active session there is nothing to end', async () => {
    await expect(stopActingAs(STOP)).resolves.toEqual({ stopped: false });
    expect(writes()).toEqual([]);
  });

  it('when the grant delete fails it throws, restores no profile and ends no session', async () => {
    answers.activeSession = ACTIVE;
    answers.grantDeleteFailsFor = [ORG_ID];
    await expect(stopActingAs(STOP)).rejects.toThrow(/grant/);
    expect(writes()).toEqual(['organization_members.delete']);
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('ends the active session and removes only the temporary grant', async () => {
    answers.activeSession = ACTIVE;
    await expect(stopActingAs(STOP)).resolves.toEqual({ stopped: true });
    expect(stub.chains.get('organization_members.delete')).toContain('not');
    expect(endedSessions()).toEqual(['s-1']);
    expect(recordPlatformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'acted_as_end' }));
  });
});

describe('sweepExpiredImpersonations', () => {
  it('a grant delete that fails ends no session for it, is reported, and the next session is still swept', async () => {
    answers.expired = {
      data: [
        { id: 's-1', admin_user_id: ADMIN_ID, target_organization_id: ORG_ID, previous_organization_id: null },
        {
          id: 's-2',
          admin_user_id: ADMIN_ID,
          target_organization_id: OTHER_ORG_ID,
          previous_organization_id: PREVIOUS_ORG_ID,
        },
      ],
      error: null,
    };
    answers.grantDeleteFailsFor = [ORG_ID];
    await expect(sweepExpiredImpersonations(1_000)).resolves.toBeUndefined();
    const deletes = stub.chainArgsAll.get('organization_members.delete') ?? [];
    expect(deletes.map((args) => args.find((a) => a[0] === 'organization_id')?.[1])).toEqual([ORG_ID, OTHER_ORG_ID]);
    expect(endedSessions()).toEqual(['s-2']);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform.impersonation.sweep-grant-delete', extra: { sessionId: 's-1' } }),
    );
  });
});
