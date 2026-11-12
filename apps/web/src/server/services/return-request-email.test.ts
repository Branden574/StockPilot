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
});

describe('returnRequestRecipientsDto', () => {
  it('is the saved pair when valid, and nothing when unset or invalid', () => {
    expect(returnRequestRecipientsDto(VALID)).toEqual({ to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Intake' });
    expect(returnRequestRecipientsDto({ state: 'unset' })).toBeNull();
    expect(returnRequestRecipientsDto({ state: 'invalid', reason: 'bad' } as never)).toBeNull();
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
    expect(res?.order.site).toEqual({ id: 'ch-1', name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } });
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
