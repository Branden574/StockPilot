import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, mfaGateError, ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import { POST } from './route';

// ═══════════════════════════════════════════════════════════════════════════
// THE PHONE'S QUICK-ADJUST BOUNDARY.
//
// Mobile's scan tab used to call the `adjust_stock` RPC DIRECTLY with a null
// location. That RPC only checks the staff-ROLE floor (0327), while every web
// adjust goes through InventoryService.adjustStock, which asserts the
// 'stock:adjust' PERMISSION — so an admin who revoked stock:adjust from a
// staffer (a 0207 override) still had every phone tap succeed. It also skipped
// the service's archived-item refusal, its "a manual add must NOT land in
// Staging" location resolution, its draw mode 'any' for null-location removals
// (the L4L 2026-08-17 `insufficient_placed_stock` incident), its audit row and
// its stock.low dispatch.
//
// This route is the parity twin of remove-stock/route.ts and carries the same
// rule its header states: "Mobile MUST go through the service, or a member
// without stock:adjust could remove stock by calling the RPC directly."
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, assertPermission: vi.fn() };
});

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function buildCtx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    permissions: undefined,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<never>(),
    supabase: {} as never,
  };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/items/${ITEM_ID}/adjust`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown) {
  const res = await POST(req(body), { params: Promise.resolve({ id: ITEM_ID }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
});

describe('POST /api/v1/items/[id]/adjust', () => {
  it('routes the adjustment through InventoryService.adjustStock (never the raw RPC)', async () => {
    const spy = vi
      .spyOn(InventoryService.prototype, 'adjustStock')
      .mockResolvedValue({ id: ITEM_ID, quantity_on_hand: 12 } as never);

    const { status, body } = await post({
      quantityChange: 5,
      movementType: 'add',
      reason: 'Mobile scan',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.quantityOnHand).toBe(12);
    expect(spy).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      quantityChange: 5,
      movementType: 'add',
      reason: 'Mobile scan',
      notes: undefined,
    });
  });

  it('refuses a caller without stock:adjust BEFORE touching the service', async () => {
    vi.mocked(assertPermission).mockImplementation(() => {
      throw new ServiceError('forbidden', 'Permission denied');
    });
    const spy = vi.spyOn(InventoryService.prototype, 'adjustStock');

    const { status, body } = await post({ quantityChange: -1, movementType: 'remove' });

    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps the service validation_error to a 400 carrying its own message', async () => {
    vi.spyOn(InventoryService.prototype, 'adjustStock').mockRejectedValue(
      new ServiceError(
        'validation_error',
        "This item's stock by location does not cover that quantity.",
      ),
    );

    const { status, body } = await post({ quantityChange: -1, movementType: 'remove' });

    expect(status).toBe(400);
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/does not cover that quantity/);
  });

  it('invalidates the org Items cache after the write lands', async () => {
    vi.spyOn(InventoryService.prototype, 'adjustStock').mockResolvedValue({
      id: ITEM_ID,
      quantity_on_hand: 7,
    } as never);

    const { status } = await post({ quantityChange: 1 });

    expect(status).toBe(200);
    expect(revalidateInventoryList).toHaveBeenCalledWith('org-1');
  });

  // The phone's whole item screen now writes through this route. The movement
  // has committed before the invalidation runs, so an invalidation that throws
  // must not become a 500: the operator would be told the +1 failed, tap again,
  // and move the stock twice.
  it('answers 200 with the new total when the cache invalidation throws', async () => {
    vi.spyOn(InventoryService.prototype, 'adjustStock').mockResolvedValue({
      id: ITEM_ID,
      quantity_on_hand: 7,
    } as never);
    const boom = new Error('revalidateTag unavailable');
    vi.mocked(revalidateInventoryList).mockImplementationOnce(() => {
      throw boom;
    });

    const { status, body } = await post({ quantityChange: 1 });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.quantityOnHand).toBe(7);
    expect(reportError).toHaveBeenCalledWith(boom, { tag: 'api.v1.items.adjust.revalidate' });
  });

  it('never invalidates when the write itself was refused', async () => {
    vi.spyOn(InventoryService.prototype, 'adjustStock').mockRejectedValue(
      new ServiceError('validation_error', 'Insufficient stock for this adjustment'),
    );

    await post({ quantityChange: -1 });

    expect(revalidateInventoryList).not.toHaveBeenCalled();
  });

  // Both an MFA step-up refusal and a missing permission are 403 'forbidden';
  // only `details.reason` tells the phone which one to explain.
  it('forwards the MFA gate reason so the phone can say "sign in again"', async () => {
    vi.mocked(assertPermission).mockImplementationOnce(() => {
      throw mfaGateError({ mfaEnrolled: true });
    });

    const { status, body } = await post({ quantityChange: 1 });

    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.details).toEqual({ reason: 'aal2_required' });
  });

  it('never forwards details on an internal_error (raw DB text stays server-side)', async () => {
    vi.spyOn(InventoryService.prototype, 'adjustStock').mockRejectedValue(
      new ServiceError('internal_error', 'relation "stock_movements" violates policy', {
        table: 'stock_movements',
      }),
    );

    const { status, body } = await post({ quantityChange: 1 });

    expect(status).toBe(500);
    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/stock_movements/);
  });

  it('rejects a zero delta — a no-op adjustment would still write a movement row', async () => {
    const spy = vi.spyOn(InventoryService.prototype, 'adjustStock');
    const { status } = await post({ quantityChange: 0, movementType: 'adjust' });
    expect(status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
