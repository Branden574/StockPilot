import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit } = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('./audit', () => ({ audit }));

import { effectivePermissions, type Role } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
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

const W1 = 'Only owners and admins can change warehouses and charters. Nothing was saved.';
const W3 = 'Nothing was saved. Reload the page and try again.';

const grant = [{ permission: 'organization:update' as const, granted: true }];

function memberCtx(stub: SupabaseStub, role: Role, overrides = [] as typeof grant) {
  return makeServiceContext(stub.client, {
    role: role as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: effectivePermissions(role, overrides),
  }) as never;
}

function stubWith(opts: { update?: QueryResult; insert?: QueryResult } = {}) {
  const writes: MockCall[] = [];
  const stub = makeSupabaseStub({
    'charters.update': (call) => {
      writes.push(call);
      return opts.update ?? { data: [{ id: CHARTER }], error: null };
    },
    'charters.insert': (call) => {
      writes.push(call);
      return opts.insert ?? { data: { id: NEW_CHARTER }, error: null };
    },
  });
  return { stub, writes };
}

beforeEach(() => {
  audit.mockClear();
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

  it('an update with no fields sends no UPDATE', async () => {
    const { stub, writes } = stubWith({ update: { data: null, error: null } });

    await new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, {});

    expect(writes).toEqual([]);
  });

  it("an admin's UPDATE that lands writes charter.updated as before", async () => {
    const { stub, writes } = stubWith();

    await new ChartersService(memberCtx(stub, 'admin')).update(CHARTER, { name: 'Renamed' });

    expect(writes).toHaveLength(1);
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
