import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { OrderAttachmentsService } from '@/server/services/order-attachments';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/order-attachments', () => ({ OrderAttachmentsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const BAD_ID = 'not-a-uuid';
const PATH = `${ORG_ID}/${ORDER_ID}/k3f9a01bcd2e.jpg`;

const add = vi.fn();

function buildCtx() {
  return {
    organizationId: ORG_ID,
    userId: 'u-1',
    role: 'manager' as const,
    permissions: undefined,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function postReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${id}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => Promise.resolve({ id });

function validBody(extra: Record<string, unknown> = {}) {
  return { storagePath: PATH, kind: 'dropoff_photo', ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockReset();
  vi.mocked(OrderAttachmentsService).mockImplementation(
    () => ({ add }) as unknown as InstanceType<typeof OrderAttachmentsService>,
  );
});

describe('POST /api/v1/orders/[id]/attachments', () => {
  it('returns 401 with no context and never records anything', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(ORDER_ID, validBody()), { params: params(ORDER_ID) });
    expect(res.status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects a malformed order id with 400 before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, validBody()), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/orders/${ORDER_ID}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'nope',
    });
    const res = await POST(req, { params: params(ORDER_ID) });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('THE SP-018 CONTRACT — a valid finalize goes through the service, which is the only place the byte sniff and PDF scan run', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockResolvedValueOnce({ id: 'att-1' });
    const res = await POST(
      postReq(ORDER_ID, validBody({ fileName: 'proof.jpg', contentType: 'image/jpeg', sizeBytes: 900 })),
      { params: params(ORDER_ID) },
    );
    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith({
      orderRequestId: ORDER_ID,
      storagePath: PATH,
      fileName: 'proof.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 900,
      kind: 'dropoff_photo',
    });
    expect(await res.json()).toEqual({ id: 'att-1' });
  });

  it('kind defaults to "other" when omitted — matching the web action', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockResolvedValueOnce({ id: 'att-2' });
    await POST(postReq(ORDER_ID, { storagePath: PATH }), { params: params(ORDER_ID) });
    expect(add).toHaveBeenCalledWith({
      orderRequestId: ORDER_ID,
      storagePath: PATH,
      fileName: null,
      contentType: null,
      sizeBytes: null,
      kind: 'other',
    });
  });

  it('an unknown kind is refused 400 before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(ORDER_ID, validBody({ kind: 'invoice' })), {
      params: params(ORDER_ID),
    });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('a traversal storagePath is refused 400 at the boundary — the service is never reached', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(
      postReq(ORDER_ID, validBody({ storagePath: `${ORG_ID}/../../item-images/victim/x/cover.jpg` })),
      { params: params(ORDER_ID) },
    );
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('maps forbidden to 403, not_found to 404 and validation_error (non-attachable status) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    add.mockRejectedValueOnce(new ServiceError('forbidden', 'managers only'));
    expect((await POST(postReq(ORDER_ID, validBody()), { params: params(ORDER_ID) })).status).toBe(403);
    add.mockRejectedValueOnce(new ServiceError('not_found', 'Order not found.'));
    expect((await POST(postReq(ORDER_ID, validBody()), { params: params(ORDER_ID) })).status).toBe(404);
    add.mockRejectedValueOnce(new ServiceError('validation_error', 'not out for delivery yet'));
    expect((await POST(postReq(ORDER_ID, validBody()), { params: params(ORDER_ID) })).status).toBe(400);
  });

  it('an unexpected throw is 500 internal_error, never the raw message', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockRejectedValueOnce(new Error('pg: connection reset'));
    const res = await POST(postReq(ORDER_ID, validBody()), { params: params(ORDER_ID) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});
