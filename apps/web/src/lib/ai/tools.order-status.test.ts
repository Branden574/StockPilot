import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_STATUS_KEYS } from '@stockpilot/core';
import type { ServiceContext } from '@/server/services/context';

/**
 * SP-133 — the two AI order tools must validate the model-supplied `status`
 * against the CANONICAL 14-key set, not a hand-copied 7-key subset.
 *
 * Two distinct failures were live:
 *   getRecentOrders   cast an arbitrary string with `as any` into
 *                     `.in('status', [...])`. An invalid key is not a DB
 *                     error — it matches zero rows, so the assistant says
 *                     "no orders in that window" over a window full of them.
 *   listOrderRequests allow-listed against a STALE 7-key Set, so a VALID key
 *                     (in_transit / backordered / picking_*) was dropped to
 *                     `undefined` and the tool returned EVERY order instead.
 *
 * Pattern #26: the same defect in two copies of the same logic — both are
 * pinned here so a future fix to one cannot silently leave the other behind.
 */

const orderListMock = vi.fn();

vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: class {
    list(...args: unknown[]) {
      return orderListMock(...args);
    }
  },
}));
vi.mock('@/server/services/inventory', () => ({ InventoryService: class {} }));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: class {} }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: class {} }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: class {} }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: class {} }));
vi.mock('@/server/services/books-import', () => ({ BooksImportService: class {} }));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({ lookupIsbn: vi.fn() }));

import { TOOL_CATALOG } from './tools';

const ctx = {
  organizationId: 'org-x',
  userId: 'user-x',
  role: 'admin',
  supabase: {} as ServiceContext['supabase'],
} as ServiceContext;

beforeEach(() => {
  vi.clearAllMocks();
  orderListMock.mockResolvedValue([]);
});

describe.each([
  ['getRecentOrders', () => TOOL_CATALOG.getRecentOrders!],
  ['listOrderRequests', () => TOOL_CATALOG.listOrderRequests!],
])('SP-133: %s status validation', (_name, getTool) => {
  it('refuses an unknown status instead of silently querying it', async () => {
    const res = (await getTool().execute({ status: 'shipped', sinceDaysAgo: 7 }, ctx)) as {
      error?: string;
      received?: string;
      allowed?: string[];
    };

    // The bad value must never reach the DB filter — `.in('status',
    // ['shipped'])` returns [] with error === null, which is
    // indistinguishable from a genuinely empty window.
    expect(orderListMock).not.toHaveBeenCalled();
    expect(res.error).toBe('unknown_status');
    expect(res.received).toBe('shipped');
    expect(res.allowed).toEqual([...ORDER_STATUS_KEYS]);
  });

  it('forwards a valid-but-previously-undocumented status to the service', async () => {
    await getTool().execute({ status: 'backordered', sinceDaysAgo: 7 }, ctx);
    expect(orderListMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'backordered' }),
    );
  });

  it('forwards in_transit too', async () => {
    await getTool().execute({ status: 'in_transit' }, ctx);
    expect(orderListMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_transit' }),
    );
  });

  it('still forwards a long-documented status unchanged', async () => {
    await getTool().execute({ status: 'approved' }, ctx);
    expect(orderListMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('omits the filter entirely when no status is supplied', async () => {
    await getTool().execute({}, ctx);
    expect(orderListMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it('documents every canonical status key in its declaration', () => {
    const desc =
      (
        getTool().declaration.parameters?.properties?.status as
          | { description?: string }
          | undefined
      )?.description ?? '';
    // Literal-pin all 14 — a tuple-derived description cannot drift, but a
    // hand-edited one can, and the model guesses exactly where we under-document.
    for (const key of [
      'pending_confirmation',
      'pending_approval',
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
      'backordered',
      'completed',
      'denied',
      'cancelled',
    ]) {
      expect(desc).toContain(key);
    }
  });
});

/**
 * Migration 0388: an order whose requester deleted their account has no
 * requester id and no email on the row. The assistant names that requester
 * "Deleted user": our own words, so fenced as data but never recorded as
 * stranger taint (which would block a manager quoting it in a write).
 */
describe('listOrderRequests: a requester who deleted their account', () => {
  const summary = (overrides: Record<string, unknown>) => ({
    id: 'ord-1',
    status: 'pending_approval',
    requesterUserId: null,
    requesterEmail: null,
    requesterName: null,
    requesterOrgLabel: null,
    requesterDeleted: false,
    warehouseName: 'Main WH',
    lineCount: 1,
    totalQuantity: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    approvedAt: null,
    ...overrides,
  });

  it('names a deleted requester "Deleted user" as a data tag, not stranger taint', async () => {
    const { createUntrustedOriginRegistry, runWithUntrustedOrigins } = await import('./untrusted');
    orderListMock.mockResolvedValueOnce([summary({ requesterDeleted: true })]);
    const registry = createUntrustedOriginRegistry();
    const res = (await runWithUntrustedOrigins(registry, () =>
      TOOL_CATALOG.listOrderRequests!.execute({}, ctx),
    )) as { requests: Array<{ requesterDisplay: unknown }> };
    expect(res.requests[0]!.requesterDisplay).toBe('<data>Deleted user</data>');
    expect(registry.phrases.size).toBe(0);
    expect(registry.shingles.size).toBe(0);
  });

  it('an external requester with no name is still "External requester", tainted as before', async () => {
    const { createUntrustedOriginRegistry, runWithUntrustedOrigins } = await import('./untrusted');
    orderListMock.mockResolvedValueOnce([summary({ requesterEmail: 'x@site.org' })]);
    const registry = createUntrustedOriginRegistry();
    const res = (await runWithUntrustedOrigins(registry, () =>
      TOOL_CATALOG.listOrderRequests!.execute({}, ctx),
    )) as { requests: Array<{ requesterDisplay: unknown }> };
    expect(res.requests[0]!.requesterDisplay).toBe('<data>External requester</data>');
    expect(registry.phrases.size).toBeGreaterThan(0);
  });
});
