import { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ReceivingService } from '@/server/services/receiving';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: vi.fn() }));
vi.mock('@/server/services/inventory', () => ({ InventoryService: vi.fn() }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: vi.fn() }));
vi.mock('@/server/services/locations', () => ({ LocationsService: vi.fn() }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: vi.fn() }));
vi.mock('@/server/services/receiving', () => ({ ReceivingService: vi.fn() }));
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToStream: vi.fn(async () => Readable.from([]) as never) };
});
// The header logo: the purchase order must get only what this answers.
vi.mock('@/lib/pdf/image-prefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/image-prefetch')>()),
  prefetchPdfLogo: vi.fn(async () => null),
}));

// Imported AFTER the mocks above so the route picks them up.
import { renderToStream } from '@react-pdf/renderer';
import { prefetchPdfLogo } from '@/lib/pdf/image-prefetch';
import { GET } from './route';

/**
 * The organization logo in the purchase order's header. logo_url is set by an
 * owner or admin and the database does not hold it to the logo bucket, so the
 * route resolves it through prefetchPdfLogo (a guarded fetch, bytes back) and
 * the document gets only that answer, never the stored value. This route had
 * no test of its own; the props are read off the element handed to
 * renderToStream, which is mocked, so no PDF is built.
 */
describe('GET /api/purchase-orders/[id]/pdf — the header logo', () => {
  const STORED = 'https://proj.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png';
  const LOGO_BYTES = 'data:image/png;base64,TE9HTw==';
  /** The route answers 400 for an id that is not a uuid (B63). */
  const PO_ID = '0a000000-0000-4000-8000-0000000000f1';

  function signInWithLogo(logoUrl: string | null) {
    const stub = makeSupabaseStub({
      'purchase_order_charges.select': { data: [], error: null },
      'organizations.select': {
        data: { name: 'Acme', logo_url: logoUrl, po_terms: 'Net 30' },
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(stub.client, { organizationId: 'org-1', role: 'admin' }) as never,
    );
  }

  function renderedOrg(): { name: string; logoUrl: string | null; poTerms: string | null } {
    const element = vi.mocked(renderToStream).mock.calls[0]?.[0] as unknown as {
      props: { org: { name: string; logoUrl: string | null; poTerms: string | null } };
    };
    return element.props.org;
  }

  async function getPdf() {
    return GET(new NextRequest(`https://test.local/api/purchase-orders/${PO_ID}/pdf`), {
      params: Promise.resolve({ id: PO_ID }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
    vi.mocked(PurchaseOrdersService).mockImplementation(function () {
      return {
        get: async () => ({
          po: {
            id: PO_ID,
            po_number: 'PO-0001',
            status: 'sent',
            notes: null,
            expected_at: null,
            created_at: '2026-10-01T00:00:00.000Z',
            subtotal: 0,
            total: 0,
            supplier_id: null,
            destination_location_id: null,
            charter_id: null,
          },
          lines: [],
        }),
      } as never;
    });
    vi.mocked(InventoryService).mockImplementation(function () {
      return { byIds: async () => [] } as never;
    });
    vi.mocked(SuppliersService).mockImplementation(function () {
      return { listForLookups: async () => [] } as never;
    });
    vi.mocked(LocationsService).mockImplementation(function () {
      return { list: async () => [] } as never;
    });
    vi.mocked(WarehousesService).mockImplementation(function () {
      return { list: async () => [] } as never;
    });
    vi.mocked(ReceivingService).mockImplementation(function () {
      return { listForPurchaseOrder: async () => ({ receipts: [], lines: [] }) } as never;
    });
  });

  it('prints the stored logo from the bytes prefetchPdfLogo answers', async () => {
    signInWithLogo(STORED);
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(LOGO_BYTES);
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(prefetchPdfLogo).toHaveBeenCalledTimes(1);
    expect(prefetchPdfLogo).toHaveBeenCalledWith(STORED);
    expect(renderedOrg()).toEqual({ name: 'Acme', logoUrl: LOGO_BYTES, poTerms: 'Net 30' });
  });

  it('prints no logo when prefetchPdfLogo answers none, whatever is stored', async () => {
    signInWithLogo(STORED);
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(null);
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(renderedOrg()).toEqual({ name: 'Acme', logoUrl: null, poTerms: 'Net 30' });
  });

  it('asks for no logo when none is stored', async () => {
    signInWithLogo(null);
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(prefetchPdfLogo).toHaveBeenCalledWith(null);
    expect(renderedOrg().logoUrl).toBeNull();
  });
});
