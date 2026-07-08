import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// parseImport pulls in the deterministic parser + storage + audit. Stub
// them out so the suite stays hermetic and exercises the REAL
// matchByVendorNumber logic (via VendorItemMappingsService) against a
// stubbed `vendor_item_mappings` table.
const { mockAudit, mockParsePoFile } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockParsePoFile: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: mockParsePoFile }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-parse-1';
const VENDOR_ID = 'vendor-1';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Minimal CanonicalPo fixture builder — only the fields parseImport reads. */
function canonicalPo(
  lines: Array<{
    lineNumber: number;
    lineType: 'inventory' | 'tax' | 'freight' | 'service' | 'fee' | 'discount' | 'unknown';
    vendorItemNumber?: string | null;
    vendorProductNumber?: string | null;
    auxiliaryNumber?: string | null;
  }>,
) {
  return {
    poNumber: 'PO-1',
    vendorName: null,
    poDate: null,
    description: null,
    preparedBy: null,
    workflow: null,
    reason: null,
    comments: null,
    shippingAddress: null,
    contactName: null,
    contactPhone: null,
    totalAmount: null,
    rawText: 'raw text',
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      lineType: l.lineType,
      qtyOrderedOriginal: 1,
      uomOriginal: 'ea',
      description: 'A line',
      unitCost: 1,
      lineTotal: 1,
      vendorItemNumber: l.vendorItemNumber ?? null,
      vendorProductNumber: l.vendorProductNumber ?? null,
      auxiliaryNumber: l.auxiliaryNumber ?? null,
      coaCode: null,
    })),
  };
}

/** Build a parseImport() stub. Adds a `download` method to storage.from()
 *  (the shared makeSupabaseStub doesn't implement it — parseImport is the
 *  only current caller that downloads from Storage). */
function makeParseStub(opts: { vendorMappings?: Array<Record<string, unknown>> } = {}) {
  const stub = makeSupabaseStub({
    'po_imports.select': {
      data: {
        id: IMPORT_ID,
        source_type: 'csv',
        storage_path: `${VENDOR_ID}/po-imports/imp.csv`,
        vendor_id: VENDOR_ID,
      },
      error: null,
    },
    'po_imports.update': { data: { id: IMPORT_ID }, error: null },
    'vendor_item_mappings.select': { data: opts.vendorMappings ?? [], error: null },
    'po_import_lines.insert': { data: null, error: null },
  });
  stub.client.storage.from = vi.fn(() => ({
    download: vi.fn(async () => ({
      data: { arrayBuffer: async () => new ArrayBuffer(0) },
      error: null,
    })),
    upload: vi.fn(async () => ({ data: { path: 'mock-path' }, error: null })),
    getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://mock/file' } })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://mock/signed' }, error: null })),
    createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
    remove: vi.fn(async () => ({ data: null, error: null })),
  }));
  return stub;
}

function insertedLines(stub: ReturnType<typeof makeParseStub>): Array<Record<string, unknown>> {
  return (stub.chainArgs.get('po_import_lines.insert')?.[0]?.[0] ?? []) as Array<
    Record<string, unknown>
  >;
}

describe('PoImportsService.parseImport — advisory vendor-number matching', () => {
  it('a vendor-number match is written as a SUGGESTION, not a link', async () => {
    mockParsePoFile.mockResolvedValue(
      canonicalPo([{ lineNumber: 1, lineType: 'inventory', vendorItemNumber: 'VN-1' }]),
    );
    const stub = makeParseStub({
      vendorMappings: [
        {
          id: 'map-1',
          vendor_id: VENDOR_ID,
          item_id: 'itm-existing',
          vendor_item_number: 'VN-1',
          vendor_product_number: null,
          auxiliary_number: null,
        },
      ],
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.parseImport(IMPORT_ID);

    const line = insertedLines(stub).find((l) => l.vendor_item_number === 'VN-1')!;
    expect(line).toBeDefined();
    expect(line.item_id).toBeNull(); // NOT auto-linked
    expect(line.suggested_item_id).toBe('itm-existing'); // suggested only
    expect(line.match_status).toBe('suggested');
  });

  it('an inventory line with no vendor-number match stays needs_review and unlinked (no suggestion)', async () => {
    mockParsePoFile.mockResolvedValue(
      canonicalPo([{ lineNumber: 1, lineType: 'inventory', vendorItemNumber: 'VN-NO-MATCH' }]),
    );
    const stub = makeParseStub({ vendorMappings: [] });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.parseImport(IMPORT_ID);

    const line = insertedLines(stub).find((l) => l.vendor_item_number === 'VN-NO-MATCH')!;
    expect(line.item_id).toBeNull();
    expect(line.suggested_item_id).toBeNull();
    expect(line.match_status).toBe('needs_review');
  });

  it('a non-inventory line (e.g. freight) stays non_inventory and unlinked, match or not', async () => {
    mockParsePoFile.mockResolvedValue(
      canonicalPo([{ lineNumber: 2, lineType: 'freight', vendorItemNumber: null }]),
    );
    const stub = makeParseStub({
      vendorMappings: [
        {
          id: 'map-1',
          vendor_id: VENDOR_ID,
          item_id: 'itm-existing',
          vendor_item_number: 'VN-1',
          vendor_product_number: null,
          auxiliary_number: null,
        },
      ],
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.parseImport(IMPORT_ID);

    const line = insertedLines(stub).find((l) => l.line_number === 2)!;
    expect(line.item_id).toBeNull();
    expect(line.suggested_item_id).toBeNull();
    expect(line.match_status).toBe('non_inventory');
  });
});
