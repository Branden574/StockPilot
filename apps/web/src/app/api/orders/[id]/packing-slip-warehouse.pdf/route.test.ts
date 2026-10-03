import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/token-hash';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Migration 0389: the warehouse packing slip carries the order's hand-over QR
 * (`/orders/sign/<token>`, which completes the order with no sign-in), so:
 *   - it is for the people who may hand the order over: effective
 *     orders:approve or the assigned driver (the panel's Print warehouse slip
 *     audience). Any other member used to get the PDF, QR included: now 403,
 *     before the export budget is spent;
 *   - the QR carries the RAW token from order_request_secrets when its sha256
 *     is the order's column; else a raw column minted before 0389 (no side
 *     token hashes to it, until slice C); else no QR (a cleared column, or a
 *     side table that cannot be read). Never the digest.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/dashboard/cached-org', () => ({ getCachedOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' } }));
vi.mock('@/lib/pdf/image-prefetch', () => ({ prefetchImagesAsDataUris: vi.fn(async () => new Map()) }));
const render = vi.fn(async (_args: { qrDataUrl: string | null }) => Buffer.from('%PDF-1.4'));
vi.mock('@/lib/pdf/packing-slip-warehouse', () => ({
  renderWarehousePackingSlipPdf: (args: { qrDataUrl: string | null }) => render(args),
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryImagesForServerDecoding = async () => new Map();
  },
}));
vi.mock('@/server/services/rack-holdings', () => ({ fetchRackHoldingsByItem: vi.fn(async () => new Map()) }));
vi.mock('qrcode', () => ({ default: { toDataURL: async (url: string) => `qr:${url}` } }));
const get = vi.fn();
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: class {
    get = get;
  },
}));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';

import { GET } from './route';

const ORDER_ID = '0a000000-0000-4000-8000-000000000391';
const RAW = '6b'.repeat(32);
const DIGEST = sha256Hex(RAW);
const LEGACY = '8c'.repeat(32);

function detail(column: string | null, driver: string | null = null) {
  return {
    request: {
      id: ORDER_ID,
      status: 'staged_for_pickup',
      warehouse_id: 'wh-1',
      delivery_charter_id: null,
      signature_token: column,
      assigned_delivery_user_id: driver,
    },
    lines: [],
  };
}

function side(raw: string | null, error = false) {
  adminHolder.client = makeSupabaseStub({
    'order_request_secrets.select': error
      ? { data: null, error: { message: 'down' } }
      : servedLikePostgrest(raw === null ? [] : [{ order_request_id: ORDER_ID, signature_token: raw }]),
  }).client;
}

function signIn(overrides: Parameters<typeof makeServiceContext>[1]) {
  const s = makeSupabaseStub({ 'warehouses.select': { data: { name: 'DC4' }, error: null } });
  vi.mocked(withApiContext).mockResolvedValue(makeServiceContext(s.client, overrides) as never);
}

async function call() {
  return GET(new NextRequest(`https://test.local/api/orders/${ORDER_ID}/packing-slip-warehouse.pdf`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
}

/** The URL the QR encodes, or null for no QR. */
function qrUrl(): string | null {
  const arg = render.mock.calls.at(-1)?.[0];
  return arg?.qrDataUrl ? arg.qrDataUrl.replace(/^qr:/, '') : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
  side(RAW);
});

describe('GET /api/orders/[id]/packing-slip-warehouse.pdf', () => {
  it('a viewer, or staff who is not the driver, is refused 403 before the export budget is spent', async () => {
    for (const who of [{ role: 'viewer' as const }, { role: 'staff' as const, userId: 'stf' }]) {
      signIn(who);
      get.mockResolvedValue(detail(DIGEST, 'someone-else'));
      const res = await call();
      expect(res.status).toBe(403);
      expect(render).not.toHaveBeenCalled();
    }
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it("an approver gets the QR of the side table's raw token (its sha256 is the column), never the digest", async () => {
    signIn({ role: 'manager' });
    get.mockResolvedValue(detail(DIGEST));
    expect((await call()).status).toBe(200);
    expect(qrUrl()).toBe(`https://stockpilotusa.com/orders/sign/${RAW}`);
    expect(qrUrl()).not.toContain(DIGEST);
  });

  it('the assigned driver (staff, no orders:approve) gets it too', async () => {
    signIn({ role: 'staff', userId: 'drv' });
    get.mockResolvedValue(detail(DIGEST, 'drv'));
    expect((await call()).status).toBe(200);
    expect(qrUrl()).toBe(`https://stockpilotusa.com/orders/sign/${RAW}`);
  });

  it('a raw column minted before 0389 (no side token hashes to it) is the QR, until slice C', async () => {
    signIn({ role: 'manager' });
    side(null);
    get.mockResolvedValue(detail(LEGACY));
    await call();
    expect(qrUrl()).toBe(`https://stockpilotusa.com/orders/sign/${LEGACY}`);
  });

  it('a stale side token with a cleared column (reopen, resume) prints no QR', async () => {
    signIn({ role: 'manager' });
    side(RAW);
    get.mockResolvedValue(detail(null));
    expect((await call()).status).toBe(200);
    expect(qrUrl()).toBeNull();
  });

  it('a side table that cannot be read prints no QR rather than the digest', async () => {
    signIn({ role: 'manager' });
    side(null, true);
    get.mockResolvedValue(detail(DIGEST));
    expect((await call()).status).toBe(200);
    expect(qrUrl()).toBeNull();
  });
});
