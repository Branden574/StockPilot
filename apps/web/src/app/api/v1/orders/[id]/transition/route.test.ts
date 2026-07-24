import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const reopenPicking = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  reopenPicking.mockReset();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(OrderRequestsService).mockImplementation(
    () => ({ reopenPicking }) as unknown as InstanceType<typeof OrderRequestsService>,
  );
});

const ORDER = '11111111-1111-1111-1111-111111111111';
const params = Promise.resolve({ id: ORDER });

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${ORDER}/transition`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/v1/orders/[id]/transition — reopen_picking', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req({ action: 'reopen_picking', reason: 'Miscount' }), { params });
    expect(res.status).toBe(401);
    expect(reopenPicking).not.toHaveBeenCalled();
  });

  it('400 when reason is missing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const res = await POST(req({ action: 'reopen_picking' }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(reopenPicking).not.toHaveBeenCalled();
  });

  it('400 when reason is blank/whitespace-only', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const res = await POST(req({ action: 'reopen_picking', reason: '   ' }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(reopenPicking).not.toHaveBeenCalled();
  });

  it('calls the service with the trimmed reason, revalidates inventory, and returns the order', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    reopenPicking.mockResolvedValueOnce({ id: ORDER, status: 'picking_in_progress' });
    const res = await POST(req({ action: 'reopen_picking', reason: '  Miscount on line 2  ' }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order: { id: ORDER, status: 'picking_in_progress' } });
    expect(reopenPicking).toHaveBeenCalledWith(ORDER, 'Miscount on line 2');
    expect(revalidateInventoryList).toHaveBeenCalledWith('o1');
  });

  it('maps a conflict ServiceError (already signed) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    reopenPicking.mockRejectedValueOnce(
      new ServiceError('conflict', "This order has been signed for and can't be reopened."),
    );
    const res = await POST(req({ action: 'reopen_picking', reason: 'Miscount' }), { params });
    expect(res.status).toBe(409);
    expect(revalidateInventoryList).not.toHaveBeenCalled();
  });

  it('maps a forbidden ServiceError (not a manager) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    reopenPicking.mockRejectedValueOnce(new ServiceError('forbidden', 'Only a manager can reopen picking.'));
    const res = await POST(req({ action: 'reopen_picking', reason: 'Miscount' }), { params });
    expect(res.status).toBe(403);
  });
});
