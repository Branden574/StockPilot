import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

// F2-3: the filtered Staging list's chip names the order it came from. One
// narrow read, org-filtered, that never throws (a chip must not take the page
// down): ok / not_found (no link back) / failed (link kept, number unknown).

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';

beforeEach(() => vi.clearAllMocks());

describe('OrderRequestsService.orderLinkLabel', () => {
  it('reads the order number and its warehouse (what the list is narrowed to), org-filtered, as the viewer', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: { id: ORDER, order_number: 123, warehouse_id: 'wh-1' }, error: null },
    });
    const svc = new OrderRequestsService(makeServiceContext(stub.client, { organizationId: 'org-9' }) as never);
    expect(await svc.orderLinkLabel(ORDER.toUpperCase())).toEqual({
      state: 'ok',
      id: ORDER,
      orderNumber: 'SO-000123',
      warehouseId: 'wh-1',
    });
    const [methods] = stub.chainsAll.get('order_requests.select')!;
    const [args] = stub.chainArgsAll.get('order_requests.select')!;
    const pairs = methods!.map((m, k) => [m, ...(args![k] ?? [])]);
    expect(pairs).toContainEqual(['select', 'id, order_number, warehouse_id']);
    expect(pairs).toContainEqual(['eq', 'organization_id', 'org-9']);
    expect(pairs).toContainEqual(['eq', 'id', ORDER]);
  });

  it('an order without a number is still an order', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: { id: ORDER, order_number: null, warehouse_id: 'wh-1' }, error: null },
    });
    const svc = new OrderRequestsService(makeServiceContext(stub.client) as never);
    expect(await svc.orderLinkLabel(ORDER)).toEqual({ state: 'ok', id: ORDER, orderNumber: null, warehouseId: 'wh-1' });
  });

  it('not found: nothing to go back to', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: null, error: null } });
    const svc = new OrderRequestsService(makeServiceContext(stub.client) as never);
    expect(await svc.orderLinkLabel(ORDER)).toEqual({ state: 'not_found' });
  });

  it('not a uuid, or Orders off: not_found without a read', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: { id: ORDER, order_number: 1 }, error: null } });
    expect(await new OrderRequestsService(makeServiceContext(stub.client) as never).orderLinkLabel('SO-1')).toEqual({
      state: 'not_found',
    });
    const modules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
    modules.delete('orders');
    expect(
      await new OrderRequestsService(makeServiceContext(stub.client, { enabledModules: modules }) as never).orderLinkLabel(ORDER),
    ).toEqual({ state: 'not_found' });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a failed read is failed (reported), never a throw', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: null, error: { message: 'boom' } } });
    const svc = new OrderRequestsService(makeServiceContext(stub.client) as never);
    expect(await svc.orderLinkLabel(ORDER)).toEqual({ state: 'failed' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'orders.link_label_failed' }));
  });
});
