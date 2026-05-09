import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: vi.fn(),
}));

// Inject tiny Buffer fakes for the dynamic imports the route does — we
// don't want to depend on the real bwip-js / qrcode binary output.
vi.mock('qrcode', () => ({
  default: { toBuffer: vi.fn(async () => Buffer.from('FAKE_QR_PNG')) },
  toBuffer: vi.fn(async () => Buffer.from('FAKE_QR_PNG')),
}));

vi.mock('bwip-js/node', () => ({
  default: { toBuffer: vi.fn(async () => Buffer.from('FAKE_C128_PNG')) },
  toBuffer: vi.fn(async () => Buffer.from('FAKE_C128_PNG')),
}));

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
  };
}

function buildRequest(url = 'https://test.local/api/v1/items/i-1/barcode') {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
}

function buildParams(id = 'i-1') {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/v1/items/[id]/barcode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Avoid the route's req.nextUrl.origin fallback (a plain Request
    // doesn't have nextUrl). Setting NEXT_PUBLIC_APP_URL short-circuits it.
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.local';
  });

  it('returns 401 when there is no auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(401);
  });

  it('returns image/png blob for default code128 format', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => ({ id: 'i-1', barcode: '012345', sku: 'SKU-1' })),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('FAKE_C128_PNG');
  });

  it('returns image/png blob when type=qr', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => ({ id: 'i-1', barcode: '012345', sku: 'SKU-1' })),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest('https://test.local/api/v1/items/i-1/barcode?type=qr'), buildParams());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('FAKE_QR_PNG');
  });

  it('returns 404 when InventoryService.get throws not_found ServiceError', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => {
          throw new ServiceError('not_found', 'Item not found');
        }),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest(), buildParams('missing'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Item not found');
  });

  it('returns 403 for forbidden ServiceError', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => {
          throw new ServiceError('forbidden', 'No access');
        }),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('No access');
  });

  it('falls back to the item id when both barcode and sku are missing', async () => {
    // Defensive: every newly-created item gets an auto-generated SKU,
    // but if data ever drifts (manual SQL insert, schema migration
    // gone wrong) we'd rather print a usable label encoding the id
    // than 400 the print dialog and block the user. The id is always
    // present and is meaningful — scanning it via the QR/code-128
    // still resolves the item via the mobile scanner's id lookup.
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => ({ id: 'i-1', barcode: null, sku: null })),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('falls back to the item id when sku is an empty string', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => ({ id: 'i-1', barcode: null, sku: '   ' })),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(200);
  });

  it('uses ?value= override even when item has its own barcode', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(InventoryService).mockImplementationOnce(
      () => ({
        get: vi.fn(async () => ({ id: 'i-1', barcode: '012345', sku: 'SKU-1' })),
      }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await GET(
      buildRequest('https://test.local/api/v1/items/i-1/barcode?value=OVERRIDE'),
      buildParams(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });
});
