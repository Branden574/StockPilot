import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { OrderRequestsService } from '@/server/services/order-requests';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const recordPickedLine = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  recordPickedLine.mockReset();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(OrderRequestsService).mockImplementation(
    () => ({ recordPickedLine }) as unknown as InstanceType<typeof OrderRequestsService>,
  );
});

const ORDER = '11111111-1111-1111-1111-111111111111';
const LINE = '22222222-2222-2222-2222-222222222222';

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${ORDER}/pick-line`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const params = Promise.resolve({ id: ORDER });

describe('POST /api/v1/orders/[id]/pick-line', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req({ lineId: LINE, quantity: 3 }), { params });
    expect(res.status).toBe(401);
    expect(recordPickedLine).not.toHaveBeenCalled();
  });

  it('429 when rate limited', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, resetAt: Date.now() + 1000 } as never);
    const res = await POST(req({ lineId: LINE, quantity: 3 }), { params });
    expect(res.status).toBe(429);
    expect(recordPickedLine).not.toHaveBeenCalled();
  });

  it('400 on an invalid body (bad lineId / negative qty)', async () => {
    vi.mocked(withApiContext).mockResolvedValue({ userId: 'u1', organizationId: 'o1' } as never);
    expect((await POST(req({ lineId: 'nope', quantity: 3 }), { params })).status).toBe(400);
    expect((await POST(req({ lineId: LINE, quantity: -1 }), { params })).status).toBe(400);
    expect(recordPickedLine).not.toHaveBeenCalled();
  });

  it('records a per-line pick and returns 200 {ok:true}', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    recordPickedLine.mockResolvedValueOnce(undefined);
    const res = await POST(req({ lineId: LINE, quantity: 4 }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(recordPickedLine).toHaveBeenCalledWith(ORDER, LINE, 4);
  });

  it('maps an over_pick validation ServiceError to 400 (not a 500)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const { ServiceError } = await import('@/server/services/context');
    recordPickedLine.mockRejectedValueOnce(
      new ServiceError('validation_error', 'Cannot pick more than requested.'),
    );
    const res = await POST(req({ lineId: LINE, quantity: 9999 }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const { ServiceError } = await import('@/server/services/context');
    recordPickedLine.mockRejectedValueOnce(new ServiceError('forbidden', 'Not allowed.'));
    const res = await POST(req({ lineId: LINE, quantity: 1 }), { params });
    expect(res.status).toBe(403);
  });
});
