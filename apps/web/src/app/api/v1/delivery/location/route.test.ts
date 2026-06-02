import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/delivery-tracking', () => ({ DeliveryTrackingService: vi.fn() }));

const shareLocation = vi.fn();

// The shared test setup runs vi.restoreAllMocks() in afterEach, which wipes
// the constructor's implementation between tests. Re-arm both the shared
// shareLocation spy and the constructor (returning that spy) before each test,
// mirroring the cycle-counts route test pattern.
beforeEach(() => {
  vi.clearAllMocks();
  shareLocation.mockReset();
  vi.mocked(DeliveryTrackingService).mockImplementation(
    () => ({ shareLocation }) as unknown as InstanceType<typeof DeliveryTrackingService>,
  );
});

function req(body: unknown) {
  return new NextRequest('http://localhost/api/v1/delivery/location', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/v1/delivery/location', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 1, lng: 2 }));
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const res = await POST(req({ orderId: 'not-a-uuid', lat: 999, lng: 2 }));
    expect(res.status).toBe(400);
  });

  it('delegates to shareLocation and returns 200', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    shareLocation.mockResolvedValueOnce(undefined);
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 }));
    expect(res.status).toBe(200);
    expect(shareLocation).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', { lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 });
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const { ServiceError } = await import('@/server/services/context');
    shareLocation.mockRejectedValueOnce(new ServiceError('forbidden', 'nope'));
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 1, lng: 2 }));
    expect(res.status).toBe(403);
  });
});
