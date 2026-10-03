import { describe, expect, it } from 'vitest';

import type { OrderExportRow } from '@/server/services/order-requests';

import { orderExportCells } from './export';

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
