import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { PoAttachmentsService } from '@/server/services/po-attachments';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/po-attachments', () => ({ PoAttachmentsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const PO_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const BAD_ID = 'not-a-uuid';
const PATH = `${ORG_ID}/${PO_ID}/k3f9a01bcd2e.pdf`;

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
  return new NextRequest(`http://localhost/api/v1/purchase-orders/${id}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => Promise.resolve({ id });

function validBody(extra: Record<string, unknown> = {}) {
  return {
    storagePath: PATH,
    fileName: 'packing-slip.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockReset();
  vi.mocked(PoAttachmentsService).mockImplementation(
    () => ({ add }) as unknown as InstanceType<typeof PoAttachmentsService>,
  );
});

describe('POST /api/v1/purchase-orders/[id]/attachments', () => {
  it('returns 401 with no context and never records anything', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) });
    expect(res.status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects a malformed PO id with 400 before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, validBody()), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/purchase-orders/${PO_ID}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    const res = await POST(req, { params: params(PO_ID) });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('THE SP-018 CONTRACT — a valid finalize goes through the service, which is the only place the byte sniff and PDF scan run', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockResolvedValueOnce({ id: 'att-1' });
    const res = await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) });
    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith({
      purchaseOrderId: PO_ID,
      storagePath: PATH,
      fileName: 'packing-slip.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });
    expect(await res.json()).toEqual({ id: 'att-1' });
  });

  it('a traversal storagePath is refused 400 at the boundary — the service is never reached', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(
      postReq(PO_ID, validBody({ storagePath: `${ORG_ID}/../../item-images/victim/x/cover.jpg` })),
      { params: params(PO_ID) },
    );
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('a percent-encoded traversal is refused 400 too', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(
      postReq(PO_ID, validBody({ storagePath: `${ORG_ID}/%2e%2e/%2e%2e/item-images/x/y.jpg` })),
      { params: params(PO_ID) },
    );
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('maps the service validation_error (wrong org/PO prefix, or a failed sniff) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockRejectedValueOnce(
      new ServiceError('validation_error', 'Invalid storage path — wrong org prefix.'),
    );
    const res = await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('maps forbidden to 403 and not_found to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    add.mockRejectedValueOnce(new ServiceError('forbidden', 'nope'));
    expect((await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) })).status).toBe(403);
    add.mockRejectedValueOnce(new ServiceError('not_found', 'Purchase order not found.'));
    expect((await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) })).status).toBe(404);
  });

  it('an unexpected throw is 500 internal_error, never the raw message', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockRejectedValueOnce(new Error('pg: connection reset'));
    const res = await POST(postReq(PO_ID, validBody()), { params: params(PO_ID) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });

  it('omitted optional metadata becomes explicit nulls for the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    add.mockResolvedValueOnce({ id: 'att-2' });
    await POST(postReq(PO_ID, { storagePath: PATH }), { params: params(PO_ID) });
    expect(add).toHaveBeenCalledWith({
      purchaseOrderId: PO_ID,
      storagePath: PATH,
      fileName: null,
      contentType: null,
      sizeBytes: null,
    });
  });
});
