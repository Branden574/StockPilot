import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit, reportError } = vi.hoisted(() => ({
  audit: vi.fn(async (..._args: unknown[]) => {}),
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { effectivePermissions, type Role } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { ChartersService } from './charters';

/**
 * Admin > Charters (B99). charters_admin_write (0140) lets only admins write
 * charters, while the service asked only organization:update, which an owner
 * or admin can give a member below admin. For such a member the UPDATE changed
 * no row with no error and the editor said "<Charter> updated.", with a
 * 'charter.updated' audit row; creating one answered "An internal error
 * occurred". The service now checks owner or admin before any write and asks
 * the UPDATE for its row back.
 */

const CHARTER = '00000000-0000-4000-8000-0000000000c1';
const NEW_CHARTER = '00000000-0000-4000-8000-0000000000c9';
/** Another organization's charter, and an id no charter has. */
const OTHER_ORG_CHARTER = '00000000-0000-4000-8000-0000000000d1';
const UNKNOWN_CHARTER = '00000000-0000-4000-8000-0000000000d9';

const W1 = 'Only owners and admins can change warehouses and charters. Nothing was saved.';
const W3 = 'Nothing was saved. Reload the page and try again.';

const grant = [{ permission: 'organization:update' as const, granted: true }];

function memberCtx(stub: SupabaseStub, role: Role, overrides = [] as typeof grant) {
  return makeServiceContext(stub.client, {
    role: role as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: effectivePermissions(role, overrides),
  }) as never;
}

/** `read` answers the charter read instead of the rows below. */
function stubWith(opts: { update?: QueryResult; insert?: QueryResult; read?: QueryResult } = {}) {
  const writes: MockCall[] = [];
  const reads: MockCall[] = [];
  const charters = servedLikePostgrest([
    { id: CHARTER, organization_id: 'org-test' },
    { id: OTHER_ORG_CHARTER, organization_id: 'org-other' },
  ]);
  const stub = makeSupabaseStub({
    'charters.select': (call) => {
      reads.push(call);
      return opts.read ?? charters(call);
    },
    'charters.update': (call) => {
      writes.push(call);
      return opts.update ?? { data: [{ id: CHARTER }], error: null };
    },
    'charters.insert': (call) => {
      writes.push(call);
      return opts.insert ?? { data: { id: NEW_CHARTER }, error: null };
    },
  });
  return { stub, writes, reads };
}

beforeEach(() => {
  audit.mockClear();
  reportError.mockClear();
});

describe('ChartersService refuses a member below admin before any write', () => {
  it('a manager granted organization:update: create, update, archive and restore are refused with W1', async () => {
    // As the database answers that manager: the INSERT refused, every UPDATE
    // changing no row.
    const { stub, writes } = stubWith({
      update: { data: null, error: null },
      insert: {
        data: null,
        error: {
          message: 'new row violates row-level security policy for table "charters"',
          code: '42501',
        },
      },
    });
    const svc = new ChartersService(memberCtx(stub, 'manager', grant));

    await expect(svc.create({ name: 'North campus', status: 'active' })).rejects.toMatchObject({
      code: 'forbidden',
      message: W1,
    });
    await expect(svc.update(CHARTER, { name: 'Renamed' })).rejects.toMatchObject({
      code: 'forbidden',
      message: W1,
    });
    await expect(svc.archive(CHARTER)).rejects.toMatchObject({ code: 'forbidden', message: W1 });
    await expect(svc.restore(CHARTER)).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(writes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('ChartersService.update asks its row back', () => {
  it("an admin's UPDATE that changes no row refuses with W3 and writes no charter.updated", async () => {
    const { stub, writes } = stubWith({ update: { data: null, error: null } });

    await expect(
      new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, { name: 'Renamed' }),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.methods).toEqual(expect.arrayContaining(['update', 'select']));
    expect(audit).not.toHaveBeenCalled();
  });

  it("an update with no fields sends no UPDATE, and reads this organization's charter first", async () => {
    const { stub, writes, reads } = stubWith({ update: { data: null, error: null } });

    await new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, {});

    expect(writes).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it.each([
    ['another organization', OTHER_ORG_CHARTER],
    ['no charter', UNKNOWN_CHARTER],
  ])(
    'an update with no fields on an id of %s: W3, and no charter.updated naming it',
    async (_label, id) => {
      const { stub, writes } = stubWith();

      await expect(
        new ChartersService(memberCtx(stub, 'admin')).update(id, {}),
      ).rejects.toMatchObject({ code: 'conflict', message: W3 });

      expect(writes).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it('an update with no fields whose row check read fails: W3, the database text only in the server report, and no charter.updated', async () => {
    const DB_TEXT = 'canceling statement due to statement timeout on "charters"';
    const { stub, writes, reads } = stubWith({
      read: { data: null, error: { message: DB_TEXT, code: '57014' } },
    });

    const refusal = await new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, {}).then(
      () => null,
      (e: unknown) => e,
    );

    expect(refusal).toMatchObject({ code: 'conflict', message: W3 });
    expect(JSON.stringify(refusal)).not.toContain('statement timeout');
    expect(reads).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String((reportError.mock.calls[0]![0] as Error).message)).toContain(DB_TEXT);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'organization_setup.row_check',
      extra: { table: 'charters', id: CHARTER },
    });
  });

  it("an admin's UPDATE that lands writes charter.updated as before", async () => {
    const { stub, writes, reads } = stubWith();

    await new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, { name: 'Renamed' });

    expect(writes).toHaveLength(1);
    // The UPDATE asks its row back: no extra read.
    expect(reads).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'charter.updated',
      entityType: 'charter',
      entityId: CHARTER,
      after: { name: 'Renamed' },
    });
  });
});

describe('ChartersService.create', () => {
  it('an INSERT the policy refuses answers W3, not the internal error', async () => {
    const { stub } = stubWith({
      insert: {
        data: null,
        error: {
          message: 'new row violates row-level security policy for table "charters"',
          code: '42501',
        },
      },
    });

    await expect(
      new ChartersService(memberCtx(stub, 'admin')).create({
        name: 'North campus',
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });
    expect(audit).not.toHaveBeenCalled();
  });

  it("the owner's create, archive and restore go through, and a missing row still says 'Charter not found.'", async () => {
    const { stub } = stubWith();
    const svc = new ChartersService(memberCtx(stub, 'owner'));

    await expect(svc.create({ name: 'North campus', status: 'active' })).resolves.toEqual({
      id: NEW_CHARTER,
    });
    await svc.archive(CHARTER);
    await svc.restore(CHARTER);

    const { stub: gone } = stubWith({ update: { data: null, error: null } });
    await expect(
      new ChartersService(memberCtx(gone, 'owner')).archive(CHARTER),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Charter not found.',
    });
  });
});
