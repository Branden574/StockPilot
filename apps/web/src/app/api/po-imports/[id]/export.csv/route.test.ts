import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import {
  PoImportsService,
  type PoImportLineRow,
  type PoImportRow,
} from '@/server/services/po-imports';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/po-imports', async (importOriginal) => {
  // Keep the real type exports but stub the class so we control get() per test.
  const actual =
    await importOriginal<typeof import('@/server/services/po-imports')>();
  return { ...actual, PoImportsService: vi.fn() };
});

// Export throttle → no-op (allow). The real one calls a rate-limit RPC that
// fails CLOSED in the no-DB test env and would 429 before the handler runs.
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
}));

function buildCtx(
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  // Real contexts (withApiContext) always carry the effective set, so an org
  // override can revoke purchase_orders:read even from a role that has it by
  // default. Pass an explicit set to exercise the permission gate.
  permissions?: Set<Permission>,
) {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    ...(permissions ? { permissions } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['po_imports']),
  };
}

const IMPORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildRequest(): Request {
  return new Request(
    `https://test.local/api/po-imports/${IMPORT_ID}/export.csv`,
  );
}

function buildParams() {
  return { params: Promise.resolve({ id: IMPORT_ID }) };
}

function line(overrides: Partial<PoImportLineRow>): PoImportLineRow {
  return {
    id: `line-${overrides.line_number ?? 0}`,
    po_import_id: IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    qty_ordered_original: 1,
    uom_original: 'EA',
    description: 'Sample',
    unit_cost: 1,
    line_total: 1,
    vendor_item_number: null,
    vendor_product_number: null,
    auxiliary_number: null,
    coa_code: null,
    item_id: null,
    suggested_item_id: null,
    match_status: 'non_inventory',
    match_confidence: null,
    extraction_confidence: null,
    exception_reason: null,
    ...overrides,
  };
}

// Mixed line types: one inventory line + a tax line + a freight line. The
// creation path drops tax/freight; this EXPORT must keep them.
const MIXED_LINES: PoImportLineRow[] = [
  line({
    line_number: 1,
    line_type: 'inventory',
    description: 'Blue Widget',
    qty_ordered_original: 10,
    uom_original: 'BX',
    unit_cost: 5,
    line_total: 50,
    vendor_item_number: 'VW-100',
    vendor_product_number: 'PN-9',
    coa_code: '5000',
  }),
  line({
    line_number: 2,
    line_type: 'tax',
    description: 'Sales Tax 8.25%',
    qty_ordered_original: null,
    uom_original: null,
    unit_cost: null,
    line_total: 4.13,
    match_status: 'non_inventory',
  }),
  line({
    line_number: 3,
    line_type: 'freight',
    description: 'Freight & Handling',
    qty_ordered_original: null,
    uom_original: null,
    unit_cost: null,
    line_total: 12.5,
    match_status: 'non_inventory',
  }),
];

// Scan-shaped parsed_json: Subtotal/Tax/Freight/Grand Total breakdown.
const SCAN_HEADER = {
  id: IMPORT_ID,
  file_name: 'acme-po-4471.pdf',
  source_type: 'scan',
  parsed_json: {
    poNumber: 'PO-4471',
    vendorName: 'Acme Supply Co',
    orderDate: '2026-06-01',
    subtotal: 50,
    tax: 4.13,
    freight: 12.5,
    grandTotal: 66.63,
  },
} as unknown as PoImportRow;

function stubGet(header: PoImportRow, lines: PoImportLineRow[]) {
  const get = vi.fn(async () => ({ header, lines }));
  vi.mocked(PoImportsService).mockImplementationOnce(
    () => ({ get }) as unknown as InstanceType<typeof PoImportsService>,
  );
  return get;
}

describe('GET /api/po-imports/[id]/export.csv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(401);
  });

  it('403s when the effective set lacks purchase_orders:manage', async () => {
    // Empty effective set = manage revoked via an org override.
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx('viewer', new Set<Permission>()),
    );
    const get = stubGet(SCAN_HEADER, MIXED_LINES);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(403);
    // The service must never run when the permission gate fails.
    expect(get).not.toHaveBeenCalled();
  });

  it('403s for a viewer on ROLE DEFAULTS — viewer has purchase_orders:read but NOT :manage', async () => {
    // The whole po_imports surface is :manage-gated (list/detail pages +
    // every service read). This export must match that floor, or staff/viewer
    // (who hold :read by default) could pull PO-import financials by URL while
    // the UI hides imports from them. buildCtx('viewer') with no explicit set
    // exercises the static role defaults exactly as a real viewer session.
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('viewer'));
    const get = stubGet(SCAN_HEADER, MIXED_LINES);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it('200s for staff+manage / lets manager+ export (has :manage)', async () => {
    // Sanity counterpart: a role WITH :manage passes the gate (the happy-path
    // export assertions live in the mixed-lines test below; this just pins
    // that the tightened gate did not over-block :manage holders).
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubGet(SCAN_HEADER, MIXED_LINES);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(200);
  });

  it('maps a not_found ServiceError (foreign / missing import) to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const get = vi.fn(async () => {
      throw new ServiceError('not_found', 'PO import not found');
    });
    vi.mocked(PoImportsService).mockImplementationOnce(
      () => ({ get }) as unknown as InstanceType<typeof PoImportsService>,
    );
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(404);
  });

  it('exports EVERY line type (tax + freight kept, not dropped) plus totals', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubGet(SCAN_HEADER, MIXED_LINES);

    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="po-import-\d{4}-\d{2}-\d{2}-acme-po-4471\.csv"/,
    );

    const body = await res.text();

    // Header row for the line-item block.
    expect(body).toContain(
      'Line #,Type,Description,Qty,UoM,Unit Cost,Line Total,Vendor #,Product #,Aux #,COA',
    );
    // Inventory line present.
    expect(body).toContain('Blue Widget');
    expect(body).toContain('VW-100');
    // Non-inventory lines that creation drops but recordkeeping keeps.
    expect(body).toContain('Sales Tax 8.25%');
    expect(body).toContain('Freight & Handling');
    // Summary block from parsed_json.
    expect(body).toContain('PO Number,PO-4471');
    expect(body).toContain('Vendor,Acme Supply Co');
    expect(body).toContain('Subtotal,50.00');
    expect(body).toContain('Grand Total,66.63');
  });

  it('emits the deterministic Total Amount when parsed_json has no breakdown', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    const deterministicHeader = {
      id: IMPORT_ID,
      file_name: 'po.csv',
      source_type: 'csv',
      parsed_json: {
        poNumber: 'PO-9',
        vendorName: 'Deterministic Vendor',
        poDate: '2026-05-05',
        totalAmount: 62.5,
      },
    } as unknown as PoImportRow;
    stubGet(deterministicHeader, MIXED_LINES);

    const res = await GET(buildRequest(), buildParams());
    const body = await res.text();
    expect(body).toContain('PO Date,2026-05-05');
    expect(body).toContain('Total Amount,62.50');
    // No scan-only breakdown rows for a deterministic import.
    expect(body).not.toContain('Grand Total,');
  });
});
