import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * "Act as this org": the reads that decide what start and stop write. A read
 * that answers an error stops the step before anything is written (the action
 * reports it and shows its sentence): it is never read as "not a member", "no
 * previous organization" or "no session to end".
 */

const { recordPlatformAudit } = vi.hoisted(() => ({
  recordPlatformAudit: vi.fn(async (_row: unknown) => {}),
}));

vi.mock('./audit', () => ({ recordPlatformAudit }));

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const ORG_ID = '0a000000-0000-4000-8000-000000000002';
const PREVIOUS_ORG_ID = '0a000000-0000-4000-8000-000000000003';
const READ_FAILED = { message: 'canceling statement due to statement timeout', code: '57014' };

/** What each read answers in a test. */
const answers: {
  activeSession: QueryResult;
  membership: QueryResult;
  profile: QueryResult;
} = {
  activeSession: { data: null, error: null },
  membership: { data: null, error: null },
  profile: { data: null, error: null },
};

let stub = makeStub();

function makeStub() {
  return makeSupabaseStub({
    'platform_impersonation_sessions.select': (call: MockCall) =>
      // The sweep's expired sessions (`.lt('expires_at', now)`), else the active one.
      call.methods.includes('lt') ? { data: [], error: null } : answers.activeSession,
    'platform_impersonation_sessions.insert': { data: null, error: null },
    'platform_impersonation_sessions.update': { data: null, error: null },
    'organizations.select': { data: { id: ORG_ID, name: 'Example Org' }, error: null },
    'organization_members.select': () => answers.membership,
    'organization_members.insert': { data: null, error: null },
    'organization_members.delete': { data: null, error: null },
    'user_profiles.select': () => answers.profile,
    'user_profiles.update': { data: null, error: null },
  });
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => stub.client,
}));

import { startActingAs, stopActingAs } from './impersonation';

/** Every write the stub saw, as "table.op". */
function writes(): string[] {
  return [...stub.chainsAll.keys()].filter((k) => !k.endsWith('.select'));
}

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeStub();
  answers.activeSession = { data: null, error: null };
  answers.membership = { data: null, error: null };
  answers.profile = { data: { default_organization_id: PREVIOUS_ORG_ID }, error: null };
});

const START = { adminUserId: ADMIN_ID, adminEmail: 'ops@example.test', organizationId: ORG_ID, now: 1_000 };

describe('startActingAs', () => {
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
    await expect(stopActingAs({ adminUserId: ADMIN_ID, adminEmail: 'ops@example.test' })).rejects.toThrow(
      /session/,
    );
    expect(writes()).toEqual([]);
  });

  it('with no active session there is nothing to end', async () => {
    await expect(stopActingAs({ adminUserId: ADMIN_ID, adminEmail: 'ops@example.test' })).resolves.toEqual({
      stopped: false,
    });
    expect(writes()).toEqual([]);
  });

  it('ends the active session and removes only the temporary grant', async () => {
    answers.activeSession = {
      data: { id: 's-1', target_organization_id: ORG_ID, previous_organization_id: PREVIOUS_ORG_ID },
      error: null,
    };
    await expect(stopActingAs({ adminUserId: ADMIN_ID, adminEmail: 'ops@example.test' })).resolves.toEqual({
      stopped: true,
    });
    expect(stub.chains.get('organization_members.delete')).toContain('not');
    expect(recordPlatformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'acted_as_end' }));
  });
});
