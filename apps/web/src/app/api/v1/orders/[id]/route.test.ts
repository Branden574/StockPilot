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
  vi.mocked(OrderRequestsService).mockImplementation(function () {
    return { get } as unknown as InstanceType<typeof OrderRequestsService>;
  });
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

  // Migration 0389: the route returned the whole order row (select('*')) to
  // any bearer member: the signature token (the hand-over credential), the
  // return and track tokens, the customer's signature image and email, the
  // internal notes. The order is now allow-listed; every phone bundle reads
  // only `lines` (digital-pick.tsx), whose shape is unchanged.
  it('returns exactly the allow-listed order fields: no token, signature or internal note ever leaves', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const SECRET = 'f'.repeat(64);
    get.mockResolvedValueOnce({
      request: {
        id: ORDER,
        status: 'picking_in_progress',
        order_number: 42,
        warehouse_id: 'wh-1',
        fulfillment_type: 'pickup',
        assigned_picker_id: 'p-1',
        picking_claimed_at: '2026-10-03T12:00:00Z',
        picking_claimed_by: 'p-1',
        signature_token: SECRET,
        signature_token_expires_at: '2026-11-01T00:00:00Z',
        return_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        public_track_token: SECRET,
        signature_data_url: 'data:image/png;base64,AAAA',
        signed_by_email: 'customer@example.com',
        internal_notes: 'do not show',
        confirmation_token_hash: SECRET,
      },
      lines: [{ id: 'l1', quantity_requested: 1, quantity_picked: 0, item: null }],
      warehouseName: 'DC4',
      requesterName: 'Raj',
      requesterEmail: 'raj@example.com',
    });
    const res = await GET(req(), { params });
    const body = await res.json();
    expect(Object.keys(body.order).sort()).toEqual(
      [
        'assigned_picker_id',
        'fulfillment_type',
        'id',
        'order_number',
        'picking_claimed_at',
        'picking_claimed_by',
        'status',
        'warehouse_id',
      ].sort(),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('aaaaaaaa-aaaa');
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('customer@example.com');
    expect(text).not.toContain('do not show');
    // The lines the phone reads are untouched.
    expect(body.lines).toEqual([{ id: 'l1', quantity_requested: 1, quantity_picked: 0, item: null }]);
  });

  it('a field missing from the row is null in the answer, never absent', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    get.mockResolvedValueOnce({ request: { id: ORDER, status: 'approved' }, lines: [], warehouseName: null, requesterName: null, requesterEmail: null });
    const body = await (await GET(req(), { params })).json();
    expect(body.order).toMatchObject({ id: ORDER, status: 'approved', picking_claimed_by: null });
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' } as never);
    const { ServiceError } = await import('@/server/services/context');
    get.mockRejectedValueOnce(new ServiceError('not_found', 'No such order.'));
    expect((await GET(req(), { params })).status).toBe(404);
  });
});
