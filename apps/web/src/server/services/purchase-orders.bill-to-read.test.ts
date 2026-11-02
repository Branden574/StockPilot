import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * B56: the PO page names the charter a purchase order is billed to
 * (purchase_orders.charter_id), as its PDF does. readBillToCharter is that
 * page's label read: the organization's charter by id, at any status (a
 * charter archived since still names the PO it billed), and it never throws.
 * A failed read is reported once and shown as "Could not be loaded"; it never
 * takes the page down (recurring pattern 1). It is never the charter that
 * owns an item's stock.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [],
    writableIds: [],
    hasAllAccess: true,
    primaryWarehouseId: null,
  })),
  assertWarehouseAccess: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}), auditMany: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));

import { PurchaseOrdersService } from './purchase-orders';

const ORG = 'org-test';
const OTHER_ORG = 'org-other';
const C = '0b000000-0000-4000-8000-0000000000c1';
const X = '0b000000-0000-4000-8000-0000000000e1';

const CHARTERS = [
  { id: C, organization_id: ORG, name: 'North Campus', code: 'NC', status: 'active' },
  { id: X, organization_id: OTHER_ORG, name: 'Elsewhere', code: 'EW', status: 'active' },
];

function serviceWith(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub(results);
  const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
  return { stub, svc };
}

function warnings() {
  return reportError.mock.calls.map(
    (c) =>
      (c as unknown as [Error, { tag: string; level: string; extra: Record<string, unknown> }])[1],
  );
}

beforeEach(() => {
  reportError.mockClear();
});

describe('PurchaseOrdersService.readBillToCharter', () => {
  it('answers none, and reads nothing, for a purchase order billed to no charter', async () => {
    const { stub, svc } = serviceWith({ 'charters.select': servedLikePostgrest(CHARTERS) });
    await expect(svc.readBillToCharter(null)).resolves.toEqual({ state: 'none' });
    await expect(svc.readBillToCharter(undefined)).resolves.toEqual({ state: 'none' });
    await expect(svc.readBillToCharter('')).resolves.toEqual({ state: 'none' });
    expect(stub.fromCalls).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each(['active', 'inactive', 'archived'])(
    'finds the charter at status %s (no status filter)',
    async (status) => {
      const rows = CHARTERS.map((r) => (r.id === C ? { ...r, status } : r));
      const { stub, svc } = serviceWith({ 'charters.select': servedLikePostgrest(rows) });
      const read = await svc.readBillToCharter(C);
      expect(read).toEqual({
        state: 'found',
        charter: expect.objectContaining({ id: C, name: 'North Campus', code: 'NC', status }),
      });
      expect(stub.chainArgs.get('charters.select')?.[0]).toEqual(['id, name, code, status']);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("reads only this organization's charters: another organization's id is unreadable", async () => {
    const { stub, svc } = serviceWith({ 'charters.select': servedLikePostgrest(CHARTERS) });
    await expect(svc.readBillToCharter(X)).resolves.toEqual({ state: 'unreadable', charterId: X });
    const chain = stub.chains.get('charters.select');
    const args = stub.chainArgs.get('charters.select');
    expect(chain).toEqual(['select', 'eq', 'eq']);
    expect(args?.[1]).toEqual(['organization_id', ORG]);
    expect(args?.[2]).toEqual(['id', X]);
  });

  it('a read error is unreadable, reported once as a warning with the raw text', async () => {
    const { svc } = serviceWith({
      'charters.select': { data: null, error: { message: 'permission denied for table charters' } },
    });
    await expect(svc.readBillToCharter(C)).resolves.toEqual({ state: 'unreadable', charterId: C });
    const reported = warnings();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.tag).toBe('purchase_orders.detail.bill_to');
    expect(reported[0]!.level).toBe('warning');
    expect(reported[0]!.extra.detail).toBe('permission denied for table charters');
  });

  it('no row is unreadable, reported once', async () => {
    const { svc } = serviceWith({ 'charters.select': servedLikePostgrest([]) });
    await expect(svc.readBillToCharter(C)).resolves.toEqual({ state: 'unreadable', charterId: C });
    const reported = warnings();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.tag).toBe('purchase_orders.detail.bill_to');
  });

  it('never rejects, even when the client throws', async () => {
    const stub = makeSupabaseStub({});
    stub.client.from = vi.fn(() => {
      throw new Error('fetch failed');
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
    await expect(svc.readBillToCharter(C)).resolves.toEqual({ state: 'unreadable', charterId: C });
    const reported = warnings();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.extra.detail).toBe('fetch failed');
  });
});
