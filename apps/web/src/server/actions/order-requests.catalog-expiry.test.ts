import { revalidateTag } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrderRequestsService } from '@/server/services/order-requests';
import { expectCatalogExpiryReaches } from '@/test/orders-catalog-tags';

import {
  addOrderRequestLinesAction,
  approveOrderRequestAction,
  cancelOrderRequestAction,
  claimPickingAction,
  completePickingAction,
  confirmPhysicalSignatureAction,
  removeOrderRequestLineAction,
  updateOrderRequestLineQuantityAction,
} from './order-requests';

/**
 * Which Place an Order catalog entries the web's order actions expire: the
 * organization's entry for the order's warehouse, from the row the service
 * answered, now (`{ expire: 0 }`). The line edits answer no row, so they
 * expire the organization's. Never every organization's (the global tag).
 */

vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn() },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => true),
}));

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const WH = '00000000-0000-4000-8000-0000000000c1';
const OTHER_WH = '00000000-0000-4000-8000-0000000000c2';
const ORDER = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

const ROW = { id: ORDER, organization_id: ORG, warehouse_id: WH, status: 'approved' };

const svc = {
  organizationId: ORG,
  approve: vi.fn(async () => ROW),
  cancel: vi.fn(async () => ROW),
  claimPicking: vi.fn(async () => ROW),
  completePicking: vi.fn(async () => ROW),
  confirmPhysicalSignature: vi.fn(async () => ({ ...ROW, status: 'completed' })),
  addLines: vi.fn(async () => ({ added: 1, merged: 0, pickSlipStale: false, hold: null })),
  updateLineQuantity: vi.fn(async () => ({ pickSlipStale: false, quantity: 2, hold: null })),
  removeLine: vi.fn(async () => ({ pickSlipStale: false, removedItemId: ITEM })),
};

const expired = () => vi.mocked(revalidateTag).mock.calls;

beforeEach(() => {
  vi.mocked(revalidateTag).mockReset();
  vi.mocked(OrderRequestsService.forCurrentUser).mockResolvedValue(svc as never);
});

describe("the web order actions expire only the order's own catalog", () => {
  it.each([
    ['approve', () => approveOrderRequestAction({ id: ORDER })],
    ['cancel', () => cancelOrderRequestAction({ id: ORDER })],
    ['claim picking', () => claimPickingAction({ id: ORDER })],
    ['complete picking', () => completePickingAction({ id: ORDER })],
    [
      'paper signature',
      () => confirmPhysicalSignatureAction({ id: ORDER, signerName: 'Sam Example' }),
    ],
  ])("%s: the order's warehouse catalog in its organization, now", async (_name, run) => {
    const res = await run();
    expect(res.ok).toBe(true);
    expect(expired()).toEqual([[`orders-new-v2-catalog:${ORG}:${WH}`, { expire: 0 }]]);
    expectCatalogExpiryReaches(
      expired().map((c) => c[0]),
      {
        hits: [[ORG, WH]],
        misses: [
          [ORG, OTHER_WH],
          [OTHER_ORG, WH],
        ],
      },
    );
  });

  it.each([
    [
      'add lines',
      () => addOrderRequestLinesAction({ id: ORDER, lines: [{ itemId: ITEM, quantity: 1 }] }),
    ],
    [
      'change a quantity',
      () => updateOrderRequestLineQuantityAction({ id: ORDER, lineId: LINE, quantity: 2 }),
    ],
    ['remove a line', () => removeOrderRequestLineAction({ id: ORDER, lineId: LINE })],
  ])(
    "%s (no order row answered): the organization's catalog, no other organization's",
    async (_name, run) => {
      const res = await run();
      expect(res.ok).toBe(true);
      expect(expired()).toEqual([[`orders-new-v2-catalog:${ORG}`, { expire: 0 }]]);
      expectCatalogExpiryReaches(
        expired().map((c) => c[0]),
        {
          hits: [
            [ORG, WH],
            [ORG, OTHER_WH],
          ],
          misses: [[OTHER_ORG, WH]],
        },
      );
    },
  );

  it('a refused transition expires nothing', async () => {
    svc.approve.mockRejectedValueOnce(new Error('boom'));
    const res = await approveOrderRequestAction({ id: ORDER });
    expect(res.ok).toBe(false);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
