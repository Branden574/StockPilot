import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { mockAudit, mockAdmin } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockAdmin: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdmin }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';

function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    po_import_id: IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    description: 'Falcons Home Jersey',
    qty_ordered_original: 3,
    uom_original: 'EA',
    unit_cost: 40,
    line_total: 120,
    vendor_item_number: null,
    vendor_product_number: null,
    auxiliary_number: null,
    coa_code: null,
    item_id: null,
    suggested_item_id: null,
    match_status: 'needs_review',
    match_confidence: null,
    extraction_confidence: 0.95,
    exception_reason: null,
    variant_size: 'M',
    variant_size_original: 'M',
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: '12',
    player_name: null,
    group_hint: 'Falcons Home Jersey',
    suggested_group_id: null,
    mapping_confidence: 0.4,
    ...over,
  };
}

function svcFor(results: Record<string, unknown>) {
  const stub = makeSupabaseStub(results as never);
  const svc = new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      organizationId: 'org-test',
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory', 'po_imports', 'sports']),
    }),
  );
  return { svc, stub };
}

beforeEach(() => vi.clearAllMocks());

describe('PoImportsService.resolveLineResults', () => {
  it('flags a low-confidence line for mapping review and leaves the rest ready', async () => {
    const { svc } = svcFor({
      'po_imports.select': { data: { id: IMPORT_ID, status: 'needs_review' }, error: null },
      'po_import_lines.select': {
        data: [line(), line({ id: 'line-ok', mapping_confidence: 0.95 })],
        error: null,
      },
      'purchase_orders.select': { data: [], error: null },
    });

    const out = await svc.resolveLineResults(IMPORT_ID);

    expect(out[LINE_ID]?.result).toBe('mapping_review_required');
    expect(out[LINE_ID]?.errorCode).toBe('IMPORT_MAPPING_REVIEW_REQUIRED');
    // No category on an unmapped line, so nothing sports-y is inferred.
    expect(out['line-ok']?.result).toBe('ready');
  });
});

describe('PoImportsService.approve — the mapping gate is SERVER-side', () => {
  it('refuses to approve while a line still has an unconfirmed column mapping', async () => {
    const { svc } = svcFor({
      'po_imports.select': { data: { id: IMPORT_ID, status: 'parsed' }, error: null },
      'po_import_lines.select': { data: [line({ item_id: 'itm-1' })], error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    await expect(
      svc.approve({
        poImportId: IMPORT_ID,
        warehouseId: '33333333-3333-4333-8333-333333333333',
        vendorId: '44444444-4444-4444-8444-444444444444',
        locationId: '55555555-5555-4555-8555-555555555555',
        lineOverrides: [],
      }),
    ).rejects.toThrow(/ambiguous column mapping/);
  });

  it('lets the same import through once the line is skipped', async () => {
    const { svc } = svcFor({
      'po_imports.select': { data: { id: IMPORT_ID, status: 'parsed' }, error: null },
      'po_import_lines.select': { data: [line({ item_id: 'itm-1' })], error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    // Skipping removes the line from finalLines, so the gate cannot fire; the
    // call then fails LATER on the charter/location resolution this stub does
    // not serve — which is proof enough that the mapping gate did not stop it.
    await expect(
      svc.approve({
        poImportId: IMPORT_ID,
        warehouseId: '33333333-3333-4333-8333-333333333333',
        vendorId: '44444444-4444-4444-8444-444444444444',
        locationId: '55555555-5555-4555-8555-555555555555',
        lineOverrides: [{ lineId: LINE_ID, skip: true }],
      }),
    ).rejects.not.toThrow(/ambiguous column mapping/);
  });
});

describe('PoImportsService.confirmLineMappings', () => {
  const HEADER = { data: { id: IMPORT_ID, status: 'needs_review' }, error: null };

  it('clears the block and audits the value it reinterpreted', async () => {
    const { svc, stub } = svcFor({
      'po_imports.select': HEADER,
      'po_import_lines.select': { data: [line()], error: null },
      'po_import_lines.update': { data: { id: LINE_ID }, error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    const r = await svc.confirmLineMappings({
      poImportId: IMPORT_ID,
      decisions: { [LINE_ID]: 'jersey_number' },
    });

    expect(r.confirmed).toBe(1);
    const patch = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch.mapping_confidence).toBe(1);
    // Confirming that it IS a jersey number leaves the value alone.
    expect(patch).not.toHaveProperty('jersey_number');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sports.import.mapping_confirmed',
        before: expect.objectContaining({ jerseyNumber: '12' }),
      }),
      expect.anything(),
    );
  });

  it('clears the number field when the column turns out to be a quantity', async () => {
    const { svc, stub } = svcFor({
      'po_imports.select': HEADER,
      'po_import_lines.select': { data: [line()], error: null },
      'po_import_lines.update': { data: { id: LINE_ID }, error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    await svc.confirmLineMappings({
      poImportId: IMPORT_ID,
      decisions: { [LINE_ID]: 'quantity' },
    });

    const patch = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch.jersey_number).toBeNull();
    // The quantity itself is NEVER rewritten from a guess.
    expect(patch).not.toHaveProperty('qty_ordered_original');
  });

  it('moves the value to the style number when that is what it was', async () => {
    const { svc, stub } = svcFor({
      'po_imports.select': HEADER,
      'po_import_lines.select': { data: [line()], error: null },
      'po_import_lines.update': { data: { id: LINE_ID }, error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    await svc.confirmLineMappings({
      poImportId: IMPORT_ID,
      decisions: { [LINE_ID]: 'style_number' },
    });

    const patch = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch.vendor_product_number).toBe('12');
    expect(patch.jersey_number).toBeNull();
  });

  it('refuses a line that is not part of the import', async () => {
    const { svc } = svcFor({
      'po_imports.select': HEADER,
      'po_import_lines.select': { data: [line()], error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    await expect(
      svc.confirmLineMappings({
        poImportId: IMPORT_ID,
        decisions: { '99999999-9999-4999-8999-999999999999': 'ignore' },
      }),
    ).rejects.toThrow(/not part of this import/);
  });

  it('refuses to change mappings on an approved import', async () => {
    const { svc } = svcFor({
      'po_imports.select': { data: { id: IMPORT_ID, status: 'approved' }, error: null },
      'po_import_lines.select': { data: [line()], error: null },
      'purchase_orders.select': { data: [], error: null },
    });

    await expect(
      svc.confirmLineMappings({
        poImportId: IMPORT_ID,
        decisions: { [LINE_ID]: 'ignore' },
      }),
    ).rejects.toThrow(/approved/);
  });
});
