// apps/web/src/server/services/platform/impersonation.seat-delete.test.ts
//
// B94: ending an Act-as seat deletes the platform admin's temporary owner
// membership, and from migration 0429 that delete also releases the open work
// the seat held, in the same statement. Neither the stop nor the sweep read
// the delete's error: a delete that failed (busy for 5 s on a row the release
// changes, a network blip) still ended the session. After a stop, the owner
// seat then outlived the session until its expiry, and no sweep ever came
// back for it (the sweep reads only sessions that have not ended).
//   sweep  on a delete error: log, leave the session open (the next sweep
//          tries again), go on with the other sessions;
//   stop   on a delete error: throw before the default organization is put
//          back and before the session is ended (the action answers an
//          error, and Stop can be pressed again).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

const h = vi.hoisted(() => ({
  admin: null as unknown,
  platformAudit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('./audit', () => ({ recordPlatformAudit: (...a: unknown[]) => h.platformAudit(...a) }));

import { stopActingAs, sweepExpiredImpersonations } from './impersonation';

const ADMIN_USER = '55555555-5555-5555-5555-555555555555';
const ORG_1 = '11111111-1111-1111-1111-111111111111';
const ORG_2 = '22222222-2222-2222-2222-222222222222';

/** The org a delete chain targets: its `.eq('organization_id', …)` value. */
function deleteOrg(call: MockCall): unknown {
  const i = call.methods.findIndex((m, k) => m === 'eq' && call.args[k]?.[0] === 'organization_id');
  return i === -1 ? undefined : call.args[i]?.[1];
}

let warned: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warned = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warned.mockRestore();
});

describe('sweepExpiredImpersonations — the seat delete fails', () => {
  it('leaves that session open for the next sweep, logs it, and still ends the others', async () => {
    const stub = makeSupabaseStub({
      'platform_impersonation_sessions.select': {
        data: [
          {
            id: 'sess-1',
            admin_user_id: ADMIN_USER,
            target_organization_id: ORG_1,
            previous_organization_id: null,
          },
          {
            id: 'sess-2',
            admin_user_id: ADMIN_USER,
            target_organization_id: ORG_2,
            previous_organization_id: null,
          },
        ],
        error: null,
      },
      'organization_members.delete': (call: MockCall) =>
        deleteOrg(call) === ORG_1
          ? {
              data: null,
              error: { message: 'canceling statement due to lock timeout', code: '55P03' },
            }
          : { data: null, error: null },
    });
    h.admin = stub.client;

    await sweepExpiredImpersonations(Date.parse('2026-11-02T12:00:00Z'));

    const ended = (stub.chainArgsAll.get('platform_impersonation_sessions.update') ?? []).map(
      (args) => args.find((a) => a[0] === 'id')?.[1],
    );
    expect(ended).toEqual(['sess-2']);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]?.join(' '))).toContain('sess-1');
  });

  it('ends every session whose seat delete succeeded, as before', async () => {
    const stub = makeSupabaseStub({
      'platform_impersonation_sessions.select': {
        data: [
          {
            id: 'sess-1',
            admin_user_id: ADMIN_USER,
            target_organization_id: ORG_1,
            previous_organization_id: null,
          },
        ],
        error: null,
      },
      'organization_members.delete': { data: null, error: null },
    });
    h.admin = stub.client;

    await sweepExpiredImpersonations(Date.parse('2026-11-02T12:00:00Z'));

    expect(stub.chainArgsAll.get('platform_impersonation_sessions.update')).toHaveLength(1);
    expect(warned).not.toHaveBeenCalled();
  });
});

describe('stopActingAs — the seat delete fails', () => {
  function arm(deleteResult: { data: unknown; error: { message: string; code?: string } | null }) {
    const stub = makeSupabaseStub({
      'platform_impersonation_sessions.select': {
        data: { id: 'sess-1', target_organization_id: ORG_1, previous_organization_id: ORG_2 },
        error: null,
      },
      'organization_members.delete': deleteResult,
    });
    h.admin = stub.client;
    return stub;
  }

  it('throws before the default organization is put back and before the session is ended', async () => {
    const stub = arm({
      data: null,
      error: { message: 'canceling statement due to lock timeout', code: '55P03' },
    });

    await expect(
      stopActingAs({ adminUserId: ADMIN_USER, adminEmail: 'admin@example.com' }),
    ).rejects.toThrow();
    expect(stub.chainsAll.get('user_profiles.update')).toBeUndefined();
    expect(stub.chainsAll.get('platform_impersonation_sessions.update')).toBeUndefined();
    expect(h.platformAudit).not.toHaveBeenCalled();
  });

  it('puts the organization back, ends the session and audits it when the delete succeeds, as before', async () => {
    const stub = arm({ data: null, error: null });

    await expect(
      stopActingAs({ adminUserId: ADMIN_USER, adminEmail: 'admin@example.com' }),
    ).resolves.toEqual({ stopped: true });
    expect(stub.chainsAll.get('user_profiles.update')).toHaveLength(1);
    expect(stub.chainsAll.get('platform_impersonation_sessions.update')).toHaveLength(1);
    expect(h.platformAudit).toHaveBeenCalledTimes(1);
  });
});
