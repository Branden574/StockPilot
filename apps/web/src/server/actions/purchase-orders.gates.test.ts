import { beforeEach, describe, expect, it, vi } from 'vitest';

// The actions under test import the inventory-list loader (cache invalidation
// helper), whose module graph builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));

const { mockUpdateStatus } = vi.hoisted(() => ({
  mockUpdateStatus: vi.fn(async () => {}),
}));

// Keep the real schema exports (updatePoStatusSchema drives the action's own
// boundary schema) but stub the service class so no DB/auth is touched.
vi.mock('@/server/services/purchase-orders', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/server/services/purchase-orders')>();
  return {
    ...actual,
    PurchaseOrdersService: {
      forCurrentUser: vi.fn(async () => ({ updateStatus: mockUpdateStatus })),
    },
  };
});

import { updatePoStatusAction } from './purchase-orders';

const PO_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

// HI-1 (path 1, part a): the action boundary must zod-reject any status the UI
// never sends. The TS union is compile-time only, so a forged call can carry a
// receivable state ('expected_inbound' / 'received' / 'partially_received') that
// writes a receivable PO — 'received' fabricates a fully-received one. Those
// must be refused BEFORE the service runs.
describe('updatePoStatusAction — status is zod-validated at the boundary', () => {
  for (const forged of ['expected_inbound', 'partially_received', 'received'] as const) {
    it(`rejects a forged '${forged}' status without ever calling the service`, async () => {
      const result = await updatePoStatusAction(PO_ID, forged as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('validation_error');
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
  }

  it('rejects a non-uuid id without calling the service', async () => {
    const result = await updatePoStatusAction('not-a-uuid', 'ordered');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  for (const ok of ['draft', 'ordered', 'cancelled'] as const) {
    it(`passes the legitimate '${ok}' status through to the service`, async () => {
      const result = await updatePoStatusAction(PO_ID, ok);
      expect(result.ok).toBe(true);
      expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(PO_ID, ok);
    });
  }
});
