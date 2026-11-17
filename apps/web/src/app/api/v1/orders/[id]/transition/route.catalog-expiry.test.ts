import { revalidateTag } from 'next/cache';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { OrderRequestsService } from '@/server/services/order-requests';
import { expectCatalogExpiryReaches } from '@/test/orders-catalog-tags';

import { POST } from './route';

// Which Place an Order catalog entries a transition from the phone expires:
// its organization's entry for the order's warehouse (from the row the service
// answered), now. Never every organization's.

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const WH = '00000000-0000-4000-8000-0000000000c1';
const OTHER_WH = '00000000-0000-4000-8000-0000000000c2';
const ORDER = '11111111-1111-1111-1111-111111111111';
const params = Promise.resolve({ id: ORDER });

const svc = {
  approve: vi.fn(),
  completePicking: vi.fn(),
  claimPicking: vi.fn(),
};

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${ORDER}/transition`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const expired = () => vi.mocked(revalidateTag).mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(withApiContext).mockResolvedValue({ userId: 'u1', organizationId: ORG } as never);
  vi.mocked(OrderRequestsService).mockImplementation(function () {
    return svc as unknown as InstanceType<typeof OrderRequestsService>;
  });
});

describe('POST /api/v1/orders/[id]/transition: the storefront catalog it expires', () => {
  it.each([
    ['approve', svc.approve],
    ['complete_picking', svc.completePicking],
    ['claim_picking', svc.claimPicking],
  ] as const)("%s: only the order's warehouse catalog, now", async (action, method) => {
    method.mockResolvedValueOnce({
      id: ORDER,
      organization_id: ORG,
      warehouse_id: WH,
      status: 'approved',
    });
    const res = await POST(req({ action }), { params });
    expect(res.status).toBe(200);
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

  it("a row without its warehouse: the organization's catalog, still never another organization's", async () => {
    svc.approve.mockResolvedValueOnce({ id: ORDER, status: 'approved' });
    const res = await POST(req({ action: 'approve' }), { params });
    expect(res.status).toBe(200);
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
  });

  it('a refused transition expires nothing', async () => {
    svc.approve.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(req({ action: 'approve' }), { params });
    expect(res.status).toBe(500);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
