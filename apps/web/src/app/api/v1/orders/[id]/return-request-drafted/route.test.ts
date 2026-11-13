import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
const record = vi.fn(async (..._a: unknown[]) => ({ recorded: true }));
vi.mock('@/server/services/return-request-draft', () => ({
  recordReturnRequestDrafted: (...a: unknown[]) => record(...a),
}));

const ORDER = 'b3f1c2d4-1111-4222-8333-444455556666';
const CTX = { organizationId: 'org-1', userId: 'u-1' };

function post(id: string, body: unknown, raw?: string) {
  const req = new NextRequest(`http://localhost/api/v1/orders/${id}/return-request-drafted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(CTX as never);
});

describe('POST /api/v1/orders/[id]/return-request-drafted', () => {
  it('401 when signed out, and nothing is recorded', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await post(ORDER, { returnNumber: 'RMA-1', isCondensed: false, surface: 'order' });
    expect(res.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('400 for an order id that is not a uuid', async () => {
    const res = await post('not-a-uuid', { returnNumber: 'RMA-1', isCondensed: false, surface: 'order' });
    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('200 recorded: the order id is the path, the context is the caller, the body is only three fields', async () => {
    const res = await post(ORDER, {
      returnNumber: 'RMA-1',
      isCondensed: true,
      surface: 'return',
      orderId: 'another-order',
      organizationId: 'another-org',
      userId: 'another-user',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(record).toHaveBeenCalledWith(CTX, {
      orderId: ORDER,
      returnNumber: 'RMA-1',
      isCondensed: true,
      surface: 'return',
    });
  });

  it('200 not recorded when the service refuses (one answer for every refusal)', async () => {
    record.mockResolvedValueOnce({ recorded: false });
    const res = await post(ORDER, { returnNumber: 'RMA-1', isCondensed: false, surface: 'order' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: false });
  });

  it('a body that is not JSON reaches the service as empty fields', async () => {
    record.mockResolvedValueOnce({ recorded: false });
    const res = await post(ORDER, null, 'not json');
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledWith(CTX, {
      orderId: ORDER,
      returnNumber: undefined,
      isCondensed: undefined,
      surface: undefined,
    });
  });
});
