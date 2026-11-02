import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit } = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('./audit', () => ({ audit }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import {
  DEFAULT_MODULE_IDS,
  effectivePermissions,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

/**
 * Settings > Public requests (B99): the public request message
 * (organizations.public_request_blurb), the switch that lets a warehouse take
 * public requests (warehouses.is_public_orderable) and the token rotation
 * behind the General request link. organizations_update and
 * warehouses_admin_write (0140) let only admins write them, while the service
 * asked only organization:update, which an owner or admin can give a member
 * below admin. For such a member each UPDATE changed no row with no error, and
 * the panel kept the new value as if it had been saved. The service now checks
 * owner or admin first (after the module check) and asks each UPDATE for its
 * row back.
 */

const WH = '00000000-0000-4000-8000-0000000000a1';

const W2 = 'Only owners and admins can change the public request settings. Nothing was saved.';
const W3 = 'Nothing was saved. Reload the page and try again.';

const grant = [{ permission: 'organization:update' as const, granted: true }];

function memberCtx(
  stub: SupabaseStub,
  role: Role,
  overrides = [] as typeof grant,
  enabledModules?: Set<ModuleId>,
) {
  return makeServiceContext(stub.client, {
    role: role as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: effectivePermissions(role, overrides),
    ...(enabledModules ? { enabledModules } : {}),
  }) as never;
}

interface Recorded {
  orgReads: MockCall[];
  orgUpdates: MockCall[];
  warehouseUpdates: MockCall[];
  linkWrites: MockCall[];
}

/** `orgUpdate` and `warehouseUpdate` answer each UPDATE as the database does:
 *  its row back for an admin (the default), none when the policy hides it. */
function stubWith(opts: { orgUpdate?: QueryResult; warehouseUpdate?: QueryResult } = {}) {
  const recorded: Recorded = { orgReads: [], orgUpdates: [], warehouseUpdates: [], linkWrites: [] };
  const stub = makeSupabaseStub({
    'organizations.select': (call) => {
      recorded.orgReads.push(call);
      return { data: { public_request_token_hash: 'a'.repeat(64) }, error: null };
    },
    'organizations.update': (call) => {
      recorded.orgUpdates.push(call);
      return opts.orgUpdate ?? { data: [{ id: 'org-test' }], error: null };
    },
    'warehouses.update': (call) => {
      recorded.warehouseUpdates.push(call);
      return opts.warehouseUpdate ?? { data: [{ id: WH }], error: null };
    },
    'public_request_links.update': (call) => {
      recorded.linkWrites.push(call);
      return { data: [{ id: 'link-1' }], error: null };
    },
    'public_request_links.insert': (call) => {
      recorded.linkWrites.push(call);
      return { data: { id: 'link-1' }, error: null };
    },
  });
  return { stub, recorded };
}

const NO_ROW: QueryResult = { data: null, error: null };

beforeEach(() => {
  audit.mockClear();
});

describe('a member below admin is refused before any read or write', () => {
  it('setWarehousePublicOrderable: a manager granted organization:update gets W2 and no UPDATE is sent', async () => {
    const { stub, recorded } = stubWith({ warehouseUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'manager', grant)).setWarehousePublicOrderable(
        WH,
        true,
      ),
    ).rejects.toMatchObject({ code: 'forbidden', message: W2 });
    expect(recorded.warehouseUpdates).toEqual([]);
  });

  it('setBlurb: a manager granted organization:update gets W2 and no UPDATE is sent', async () => {
    const { stub, recorded } = stubWith({ orgUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'manager', grant)).setBlurb('Ask us for books.'),
    ).rejects.toMatchObject({ code: 'forbidden', message: W2 });
    expect(recorded.orgUpdates).toEqual([]);
  });

  it('rotatePublicToken: a manager granted organization:update gets W2 before any read', async () => {
    const { stub, recorded } = stubWith({ orgUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'manager', grant)).rotatePublicToken(),
    ).rejects.toMatchObject({ code: 'forbidden', message: W2 });
    expect(recorded.orgReads).toEqual([]);
    expect(recorded.orgUpdates).toEqual([]);
    expect(recorded.linkWrites).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('the module check still comes first', async () => {
    const { stub } = stubWith();
    const off = new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'public_requests'));
    const svc = new OrderRequestsService(memberCtx(stub, 'manager', grant, off));

    await expect(svc.setBlurb('x')).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.setWarehousePublicOrderable(WH, true)).rejects.toMatchObject({
      code: 'module_disabled',
    });
    await expect(svc.rotatePublicToken()).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe("an admin's UPDATE asks its row back", () => {
  it('the switch: an UPDATE that changes no row refuses with W3', async () => {
    const { stub, recorded } = stubWith({ warehouseUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'admin')).setWarehousePublicOrderable(WH, true),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });
    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(recorded.warehouseUpdates[0]!.methods).toEqual(
      expect.arrayContaining(['update', 'select']),
    );
  });

  it('the message: an UPDATE that changes no row refuses with W3', async () => {
    const { stub, recorded } = stubWith({ orgUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'admin')).setBlurb('Ask us for books.'),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });
    expect(recorded.orgUpdates).toHaveLength(1);
  });

  it('rotatePublicToken: an organizations UPDATE that changes no row refuses with W3 before the link row is touched', async () => {
    const { stub, recorded } = stubWith({ orgUpdate: NO_ROW });

    await expect(
      new OrderRequestsService(memberCtx(stub, 'admin')).rotatePublicToken(),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });
    expect(recorded.orgUpdates).toHaveLength(1);
    expect(recorded.linkWrites).toEqual([]);
    expect(stub.fromCalls).not.toContain('public_request_links');
    expect(audit).not.toHaveBeenCalled();
  });

  it('the switch and the message save for an admin whose UPDATE lands', async () => {
    const { stub, recorded } = stubWith();
    const svc = new OrderRequestsService(memberCtx(stub, 'admin'));

    await svc.setWarehousePublicOrderable(WH, true);
    await svc.setBlurb('Ask us for books.');

    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(recorded.orgUpdates).toHaveLength(1);
  });
});
