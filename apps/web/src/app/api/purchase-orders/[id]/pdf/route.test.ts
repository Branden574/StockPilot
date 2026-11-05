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
import { reportError } from '@/lib/error-reporter';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

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
      return {
        historyForPurchaseOrder: async () => ({ state: 'ok', receipts: [], lines: [] }),
      } as never;
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

/**
 * The Receipts section of the purchase order's PDF (B67). It reads the same
 * answer as the PO's page, `historyForPurchaseOrder`: with Receiving off, or
 * when the receipts cannot be read, the PDF prints without Receipts, as
 * before. What changed: a failed read is reported (the route caught every
 * error and reported none), a failed lookup of a receipt's items is reported
 * by the route, and the read sits outside any try, so a ReceivingService
 * without it (a stale mock, a rename) is a 500 that is reported, never a PDF
 * quietly missing its receipts.
 */
describe('GET /api/purchase-orders/[id]/pdf — the Receipts section', () => {
  const PO_ID = '0a000000-0000-4000-8000-0000000000f1';
  const RECEIPT_ID = '0a000000-0000-4000-8000-0000000000c1';
  /** An item a receipt names that is no longer on the PO's lines. */
  const SWAPPED_ITEM = '0a000000-0000-4000-8000-0000000000e1';

  const RECEIPT_ROWS = {
    'receipts.select': {
      data: [
        {
          id: RECEIPT_ID,
          receipt_number: 'RCV-0001',
          status: 'posted',
          received_at: '2026-10-20T16:00:00.000Z',
          received_by: null,
          deleted_users: null,
        },
      ],
      error: null,
    },
    'receipt_lines.select': {
      data: [
        {
          id: 'rl-1',
          receipt_id: RECEIPT_ID,
          item_id: SWAPPED_ITEM,
          qty_accepted_base: 4,
          qty_rejected_base: 0,
        },
      ],
      error: null,
    },
  };

  function modules(receivingOn: boolean): Set<ModuleId> {
    const set = new Set<ModuleId>(DEFAULT_MODULE_IDS);
    set.add('purchase_orders');
    if (receivingOn) set.add('receiving');
    else set.delete('receiving');
    return set;
  }

  function signIn(receivingOn: boolean, results: Parameters<typeof makeSupabaseStub>[0] = {}) {
    const stub = makeSupabaseStub({
      'purchase_order_charges.select': { data: [], error: null },
      'organizations.select': {
        data: { name: 'Acme', logo_url: null, po_terms: null },
        error: null,
      },
      ...RECEIPT_ROWS,
      ...results,
    });
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(stub.client, {
        organizationId: 'org-1',
        role: 'admin',
        enabledModules: modules(receivingOn),
      }) as never,
    );
    return stub;
  }

  /** The real ReceivingService, on the context the route builds. */
  async function useRealReceiving() {
    const actual = await vi.importActual<typeof import('@/server/services/receiving')>(
      '@/server/services/receiving',
    );
    vi.mocked(ReceivingService).mockImplementation(function (ctx: unknown) {
      return new actual.ReceivingService(ctx as never);
    } as never);
  }

  function renderedReceipts(): unknown[] {
    const element = vi.mocked(renderToStream).mock.calls[0]?.[0] as unknown as {
      props: { receipts: unknown[] };
    };
    return element.props.receipts;
  }

  function reportTags(): string[] {
    return vi.mocked(reportError).mock.calls.map((c) => (c[1] as { tag: string }).tag);
  }

  async function getPdf() {
    return GET(new NextRequest(`https://test.local/api/purchase-orders/${PO_ID}/pdf`), {
      params: Promise.resolve({ id: PO_ID }),
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
    vi.mocked(PurchaseOrdersService).mockImplementation(function () {
      return {
        get: async () => ({
          po: {
            id: PO_ID,
            po_number: 'PO-0001',
            status: 'partially_received',
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
      return {
        byIds: async (ids: string[]) =>
          ids.map((id) => ({ id, name: 'Sample notebook', sku: 'NB-1' })),
      } as never;
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
    await useRealReceiving();
  });

  it('control: Receiving on prints the receipts, with the item a receipt names', async () => {
    signIn(true);
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(renderedReceipts()).toEqual([
      expect.objectContaining({
        receiptNumber: 'RCV-0001',
        totalAccepted: 4,
        lines: [{ sku: 'NB-1', name: 'Sample notebook', accepted: 4, rejected: 0 }],
      }),
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a failed receipts read: the PDF prints without Receipts, and the failure is reported', async () => {
    signIn(true, {
      'receipts.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      },
    });
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(renderedReceipts()).toEqual([]);
    expect(reportTags()).toEqual(['receiving.po_history']);
  });

  it('Receiving off: the PDF prints without Receipts, reads no receipts and reports nothing', async () => {
    const stub = signIn(false);
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(renderedReceipts()).toEqual([]);
    expect(stub.fromCalls).not.toContain('receipts');
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed lookup of a receipt's items: the PDF prints without Receipts, and the route reports it", async () => {
    signIn(true);
    let calls = 0;
    vi.mocked(InventoryService).mockImplementation(function () {
      return {
        byIds: async () => {
          calls += 1;
          // The PO's own lines read first; the receipts' missing items second.
          if (calls === 2) throw new Error('fetch failed');
          return [];
        },
      } as never;
    });
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(renderedReceipts()).toEqual([]);
    expect(reportTags()).toEqual(['pdf.purchase_order.receipts']);
  });

  it('a ReceivingService without historyForPurchaseOrder is a reported 500, not a PDF missing its receipts', async () => {
    signIn(true);
    // The shape of a mock written before the read was renamed.
    vi.mocked(ReceivingService).mockImplementation(function () {
      return { listForPurchaseOrder: async () => ({ receipts: [], lines: [] }) } as never;
    });
    const res = await getPdf();
    expect(res.status).toBe(500);
    expect(renderToStream).not.toHaveBeenCalled();
    expect(reportTags()).toEqual(['pdf.purchase_order']);
  });
});
