import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const getOrgEmailRouting = vi.fn();
vi.mock('@/lib/dashboard/cached-org', () => ({
  getOrgEmailRouting: (...a: unknown[]) => getOrgEmailRouting(...a),
}));
const orderGet = vi.fn();
vi.mock('./order-requests', () => ({
  OrderRequestsService: class {
    constructor(public readonly ctx: unknown) {}
    get(id: string) {
      return orderGet(id, this.ctx);
    }
  },
}));

const resolveMemberOrder = vi.fn();
vi.mock('./returns', () => ({ resolveMemberOrder: (...a: unknown[]) => resolveMemberOrder(...a) }));
const ADMIN = { tag: 'service-role' };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ADMIN }));

import { ServiceError } from './context';
import {
  loadReturnRequestEmailForOrder,
  loadReturnRequestEmailForReturn,
  returnRequestRecipientsDto,
} from './return-request-email';

const ORDER = 'b3f1c2d4-1111-4222-8333-444455556666';
const RETURN = 'c3f1c2d4-1111-4222-8333-444455556666';
// Reserved test domains only.
const VALID = { state: 'valid' as const, recipients: { to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Intake' } };
const ON = new Set<ModuleId>(['orders', 'returns'] as ModuleId[]);

function detail(over: Record<string, unknown> = {}) {
  return {
    request: { id: ORDER, requester_user_id: 'u-req', order_number: 85, delivery_charter_id: null },
    warehouseName: 'Main Warehouse',
    requesterDisplay: 'Sample Requester · School',
    requesterName: 'Sample Requester',
    requesterEmail: 'requester@school.test',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgEmailRouting.mockResolvedValue(VALID);
  orderGet.mockResolvedValue(detail());
  // The door is open by default: the caller's own, returnable, non-portal order.
  resolveMemberOrder.mockResolvedValue({ orderRequestId: ORDER, organizationId: 'org-a' });
});

describe('returnRequestRecipientsDto', () => {
  it('is the saved pair when valid, and nothing when unset or invalid', () => {
    expect(returnRequestRecipientsDto(VALID)).toEqual({ to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Intake' });
    expect(returnRequestRecipientsDto({ state: 'unset' })).toBeNull();
    expect(returnRequestRecipientsDto({ state: 'invalid', reason: 'bad' } as never)).toBeNull();
    // Never the compiled pair the delivery request falls back to on a
    // database that predates the routing column.
    expect(returnRequestRecipientsDto({ state: 'fallback' })).toBeNull();
    expect(
      returnRequestRecipientsDto({ state: 'valid', recipients: { to: 'not-an-address', cc: 'copy@warehouse.test' } }),
    ).toBeNull();
  });
});

describe('loadReturnRequestEmailForReturn', () => {
  it("reads the caller organization's delivery-request mailboxes and links to the return", async () => {
    const res = await loadReturnRequestEmailForReturn({ organizationId: 'org-a' }, RETURN);
    expect(getOrgEmailRouting).toHaveBeenCalledWith('org-a', 'delivery_request');
    expect(res).toEqual({
      recipients: { to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Intake' },
      link: `https://stockpilotusa.com/dashboard/returns/${RETURN}`,
    });
  });

  it('a failed mailbox read is no mailboxes, never an error', async () => {
    getOrgEmailRouting.mockRejectedValueOnce(new Error('down'));
    expect((await loadReturnRequestEmailForReturn({ organizationId: 'org-a' }, RETURN)).recipients).toBeNull();
  });
});

describe('loadReturnRequestEmailForOrder', () => {
  const ctxFor = (stub: ReturnType<typeof makeSupabaseStub>, over: Parameters<typeof makeServiceContext>[1] = {}) =>
    makeServiceContext(stub.client, { enabledModules: ON, role: 'staff', userId: 'u-req', organizationId: 'org-a', ...over });

  it("answers the order's own requester with the mailboxes and the order facts the website passes", async () => {
    const stub = makeSupabaseStub({});
    const res = await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER);
    expect(res).toEqual({
      recipients: { to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Intake' },
      order: {
        orderNumber: 'SO-000085',
        requestedBy: 'Sample Requester',
        requesterEmail: 'requester@school.test',
        site: null,
        warehouseName: 'Main Warehouse',
        link: `https://stockpilotusa.com/dashboard/orders/${ORDER}#your-requests`,
      },
    });
    expect(getOrgEmailRouting).toHaveBeenCalledWith('org-a', 'delivery_request');
    // No delivery site on the order: the charters table is not read.
    expect(stub.fromCalls).toEqual([]);
    // The door is the member return request's own, scoped by the context.
    expect(resolveMemberOrder).toHaveBeenCalledWith(ADMIN, {
      organizationId: 'org-a',
      userId: 'u-req',
      orderRequestId: ORDER,
    });
  });

  it('the answer is an allow-list: these keys and no others, with no id but the link', async () => {
    orderGet.mockResolvedValue(
      detail({
        request: {
          id: ORDER,
          requester_user_id: 'u-req',
          order_number: 85,
          delivery_charter_id: 'ch-1',
          internal_notes: 'STAFF NOTE',
          warehouse_id: 'wh-1',
        },
        lines: [{ unit_cost_at_request: 12.34 }],
        reservations: [{ id: 'res-1' }],
        assignedPickerName: 'A Picker',
      }),
    );
    const stub = makeSupabaseStub({
      'charters.select': { data: { id: 'ch-1', name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } }, error: null },
    });
    const res = (await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER))!;
    expect(Object.keys(res).sort()).toEqual(['order', 'recipients']);
    expect(Object.keys(res.order).sort()).toEqual([
      'link',
      'orderNumber',
      'requestedBy',
      'requesterEmail',
      'site',
      'warehouseName',
    ]);
    expect(Object.keys(res.order.site!).sort()).toEqual(['address', 'code', 'name']);
    const text = JSON.stringify(res);
    for (const never of ['STAFF NOTE', '12.34', 'res-1', 'A Picker', 'wh-1', 'ch-1', 'org-a', 'u-req']) {
      expect(text, never).not.toContain(never);
    }
  });

  it('the door closed (a portal order, one not handed over, another member\'s, another organization\'s): nothing, and nothing more is read', async () => {
    resolveMemberOrder.mockResolvedValue(null);
    const stub = makeSupabaseStub({});
    expect(await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER)).toBeNull();
    expect(orderGet).not.toHaveBeenCalled();
    expect(getOrgEmailRouting).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });

  it('falls back to the display name, and reads the delivery site inside the organization', async () => {
    orderGet.mockResolvedValue(
      detail({
        requesterName: null,
        request: { id: ORDER, requester_user_id: 'u-req', order_number: 85, delivery_charter_id: 'ch-1' },
      }),
    );
    const stub = makeSupabaseStub({
      'charters.select': {
        data: { id: 'ch-1', name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } },
        error: null,
      },
    });
    const res = await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER);
    expect(res?.order.requestedBy).toBe('Sample Requester · School');
    expect(res?.order.site).toEqual({ name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } });
    const methods = stub.chains.get('charters.select') ?? [];
    const args = stub.chainArgs.get('charters.select') ?? [];
    const eqs = methods.map((m, i) => [m, ...(args[i] ?? [])]).filter(([m]) => m === 'eq');
    expect(eqs).toEqual(expect.arrayContaining([['eq', 'organization_id', 'org-a'], ['eq', 'id', 'ch-1']]));
  });

  it('is nothing for a member who is not the requester, whatever their role, and reads no mailbox', async () => {
    for (const role of ['staff', 'manager', 'admin'] as const) {
      const stub = makeSupabaseStub({});
      expect(await loadReturnRequestEmailForOrder(ctxFor(stub, { role, userId: 'someone-else' }) as never, ORDER)).toBeNull();
    }
    expect(getOrgEmailRouting).not.toHaveBeenCalled();
  });

  it("is nothing for another organization's or a missing order (the scoped read finds none)", async () => {
    orderGet.mockRejectedValue(new ServiceError('not_found', 'Order request not found'));
    const stub = makeSupabaseStub({});
    expect(await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER)).toBeNull();
    expect(getOrgEmailRouting).not.toHaveBeenCalled();
  });

  it('is nothing while the returns module is off, before anything is read', async () => {
    const stub = makeSupabaseStub({});
    const ctx = ctxFor(stub, { enabledModules: new Set<ModuleId>(['orders'] as ModuleId[]) });
    expect(await loadReturnRequestEmailForOrder(ctx as never, ORDER)).toBeNull();
    expect(orderGet).not.toHaveBeenCalled();
  });

  it('no mailboxes saved: the facts still answer, with recipients null', async () => {
    getOrgEmailRouting.mockResolvedValue({ state: 'unset' });
    const stub = makeSupabaseStub({});
    expect((await loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER))?.recipients).toBeNull();
  });

  it('an internal failure of the order read is thrown, not hidden', async () => {
    orderGet.mockRejectedValue(new ServiceError('internal_error', 'boom'));
    const stub = makeSupabaseStub({});
    await expect(loadReturnRequestEmailForOrder(ctxFor(stub) as never, ORDER)).rejects.toBeInstanceOf(ServiceError);
  });
});
