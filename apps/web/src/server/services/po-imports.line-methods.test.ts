/**
 * Tests for PoImportsService.findDuplicatesForLines / .createItemsFromLines —
 * the Bearer-route entry points added for mobile PO-imports parity. The route
 * suites mock the service, so THIS suite proves the real wrappers:
 *   - assert purchase_orders:manage before touching the DB,
 *   - org-scope the import id (foreign/unknown → not_found),
 *   - delegate to the shared po-imports-lines implementation (same matches
 *     shape the web action returns).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Same hermetic preamble as po-imports.list.test.ts — stub the heavy
// collaborators the service module pulls in at import time.
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { PoImportsService } from './po-imports';

beforeEach(() => {
  vi.clearAllMocks();
});

const IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';

describe('PoImportsService.findDuplicatesForLines', () => {
  it('throws forbidden for a viewer (no purchase_orders:manage) BEFORE touching the DB', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { role: 'viewer' }) as never,
    );

    await expect(
      svc.findDuplicatesForLines({ poImportId: IMPORT_ID, lineIds: [LINE_ID] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('throws not_found for a foreign-org / unknown import id (org-scoped guard)', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await expect(
      svc.findDuplicatesForLines({ poImportId: IMPORT_ID, lineIds: [LINE_ID] }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // The guard is org-scoped: .eq(organization_id, ctx org) + .eq(id, import).
    const chain = stub.chains.get('po_imports.select') ?? [];
    const args = stub.chainArgs.get('po_imports.select') ?? [];
    const eqArgs = chain
      .map((m, i) => (m === 'eq' ? args[i] : null))
      .filter((a): a is unknown[] => a !== null);
    expect(eqArgs).toContainEqual(['organization_id', 'org-test']);
    expect(eqArgs).toContainEqual(['id', IMPORT_ID]);
  });

  it('returns barcode-first matches keyed by line id (shared web implementation)', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: { id: IMPORT_ID }, error: null },
      'po_import_lines.select': {
        data: [
          {
            id: LINE_ID,
            description: 'Widget (ABC123)',
            vendor_item_number: 'V1',
            vendor_product_number: null,
            auxiliary_number: null,
          },
        ],
        error: null,
      },
      'inventory_items.select': {
        data: [{ id: 'item-1', name: 'Widget', sku: 'SKU-1', barcode: 'V1', quantity_on_hand: 3 }],
        error: null,
      },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const { matches } = await svc.findDuplicatesForLines({
      poImportId: IMPORT_ID,
      lineIds: [LINE_ID],
    });

    expect(matches).toEqual({
      [LINE_ID]: [
        {
          id: 'item-1',
          name: 'Widget',
          sku: 'SKU-1',
          barcode: 'V1',
          quantityOnHand: 3,
          matchType: 'barcode',
        },
      ],
    });
  });

  it('omitted lineIds = all lines of the import, capped at 200', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: { id: IMPORT_ID }, error: null },
      'po_import_lines.select': { data: [], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const { matches } = await svc.findDuplicatesForLines({ poImportId: IMPORT_ID });

    expect(matches).toEqual({});
    const chain = stub.chains.get('po_import_lines.select') ?? [];
    const args = stub.chainArgs.get('po_import_lines.select') ?? [];
    const limitIdx = chain.indexOf('limit');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(args[limitIdx]).toEqual([200]);
    expect(chain).not.toContain('in');
  });
});

describe('PoImportsService.createItemsFromLines', () => {
  it('throws forbidden for a viewer (no purchase_orders:manage) BEFORE touching the DB', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { role: 'viewer' }) as never,
    );

    await expect(
      svc.createItemsFromLines({
        poImportId: IMPORT_ID,
        lineIds: [LINE_ID],
        vendorId: VENDOR_ID,
        warehouseId: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('throws not_found for a foreign-org / unknown import id (org-scoped guard)', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await expect(
      svc.createItemsFromLines({
        poImportId: IMPORT_ID,
        lineIds: [LINE_ID],
        vendorId: VENDOR_ID,
        warehouseId: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Fails closed before ever reading lines or creating anything.
    expect(stub.chains.get('po_import_lines.select')).toBeUndefined();
    expect(stub.chains.get('inventory_items.insert')).toBeUndefined();
  });
});
