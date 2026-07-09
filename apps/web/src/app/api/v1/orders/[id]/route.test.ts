import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const get = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  get.mockReset();
  vi.mocked(OrderRequestsService).mockImplementation(
    () => ({ get }) as unknown as InstanceType<typeof OrderRequestsService>,
  );
});

const ORDER = '11111111-1111-1111-1111-111111111111';
const params = Promise.resolve({ id: ORDER });
const req = () => new NextRequest(`http://localhost/api/v1/orders/${ORDER}`);

describe('GET /api/v1/orders/[id]', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await GET(req(), { params })).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns the order header AND its per-line items (so mobile can pick line-by-line)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    get.mockResolvedValueOnce({
      request: { id: ORDER, status: 'pick_slip_generated' },
      lines: [
        { id: 'l1', quantity_requested: 5, quantity_picked: null, item: { name: 'Widget', sku: 'W-1' } },
      ],
      warehouseName: 'DC4',
      requesterName: 'Raj',
      requesterEmail: 'raj@example.com',
    });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.status).toBe('pick_slip_generated');
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].quantity_requested).toBe(5);
    expect(body.requesterName).toBe('Raj');
    expect(get).toHaveBeenCalledWith(ORDER);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const { ServiceError } = await import('@/server/services/context');
    get.mockRejectedValueOnce(new ServiceError('not_found', 'No such order.'));
    expect((await GET(req(), { params })).status).toBe(404);
  });
});
