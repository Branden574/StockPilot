import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { OrderRequestsService, type OrderExportRow } from '@/server/services/order-requests';

import {
  isOrderStatusTab,
  ORDER_EXPORT_STATUS_TABS,
  ORDER_EXPORT_TAB_LABELS,
  orderExportCells,
  ORDERS_AWAITING_SIGNATURE_HREF,
} from './export';


/**
 * The requester cell both order exports (CSV and PDF) print. Migration 0388:
 * an order whose requester deleted their account says "Deleted user", not
 * "(external)".
 */
function exportRow(overrides: Partial<OrderExportRow>): OrderExportRow {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    status: 'completed',
    requesterName: null,
    requesterEmail: null,
    requesterOrgLabel: null,
    requesterDeleted: false,
    warehouseName: 'Main WH',
    charterLabel: null,
    fulfillmentType: 'pickup',
    source: 'internal',
    lineCount: 1,
    totalQuantity: 1,
    totalCost: 0,
    notes: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    approvedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('orderExportCells requester', () => {
  it('a deleted requester reads "Deleted user", with an empty email cell', () => {
    const cells = orderExportCells(exportRow({ requesterDeleted: true }));
    expect(cells.requester).toBe('Deleted user');
    expect(cells.requester_email).toBe('');
  });

  it('no name or email and not deleted stays "(external)"', () => {
    expect(orderExportCells(exportRow({})).requester).toBe('(external)');
  });

  it('a name, then an email, win over either fallback', () => {
    expect(orderExportCells(exportRow({ requesterName: 'Jane', requesterDeleted: true })).requester).toBe('Jane');
    expect(orderExportCells(exportRow({ requesterEmail: 'j@site.org' })).requester).toBe('j@site.org');
  });
});

// L88: the dashboard's "N orders waiting for signature" card linked
// `/dashboard/orders?tab=in_transit`. The Orders page reads `?status=`, so the
// link landed on Needs approval, and the count spans two statuses (staged for
// pickup and in transit) that sit on two tabs. It now links a filter of its
// own, `?status=awaiting_signature`, over exactly the counted statuses.
describe('the Waiting for signature filter (L88)', () => {
  it('is a status filter key over staged for pickup and in transit, labelled "Waiting for signature"', () => {
    expect(isOrderStatusTab('awaiting_signature')).toBe(true);
    expect(ORDER_EXPORT_STATUS_TABS.awaiting_signature).toEqual(['staged_for_pickup', 'in_transit']);
    expect(ORDER_EXPORT_TAB_LABELS.awaiting_signature).toBe('Waiting for signature');
    expect(ORDERS_AWAITING_SIGNATURE_HREF).toBe('/dashboard/orders?status=awaiting_signature');
  });

  it('lists exactly the statuses the dashboard count counts', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: null, error: null, count: 0 } });
    await new OrderRequestsService(makeServiceContext(stub.client) as never).awaitingSignatureCount();
    const args = stub.chainArgs.get('order_requests.select') ?? [];
    const inArg = args[stub.chains.get('order_requests.select')!.indexOf('in')];
    expect(inArg).toEqual(['status', ORDER_EXPORT_STATUS_TABS.awaiting_signature]);
  });

  it('the dashboard card links through it, never a ?tab= the Orders page ignores', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/dashboard/page.tsx'),
      'utf8',
    );
    expect(src).toContain('href: ORDERS_AWAITING_SIGNATURE_HREF');
    expect(src).not.toMatch(/dashboard\/orders\?tab=/);
  });
});
