import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportRows, INVENTORY_EXPORT_HEADERS } from '@/lib/inventory-export';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Regression test for the LEGACY `GET /api/inventory/export.csv` route
 * (fix-wave Finding 2). This route predates the unified
 * `POST /api/inventory/export` route (which already has its own test file,
 * route.test.tsx, one directory up) and had ZERO coverage of its own before
 * this file — exactly the gap that let a column silently drift or a charter
 * value silently regress without any test catching it.
 *
 * Pins:
 *   (a) the exact 25-column header row — an accidental add/remove/reorder in
 *       INVENTORY_EXPORT_HEADERS fails here even though this test never
 *       imports that array as its assertion target (see below).
 *   (b) a null-charter row renders "Generic" (the R1 delta).
 *   (c) a charter id whose lookup failed closed renders '' — NOT "Generic".
 *       Conflating "no charter" with "lookup failed" would be dishonest: a
 *       degraded lookup says nothing about whether the item is generic stock.
 *
 * Same seams as the sibling unified-route test
 * (../export/route.test.tsx): auth context, rate limiting, and the
 * warehouse-filter cookie are mocked, and so is buildInventoryExportRows
 * itself — EXCEPT `importOriginal` keeps INVENTORY_EXPORT_HEADERS real, so
 * the mocked `headers` field below is fed from the ACTUAL production
 * constant, not a copy. The assertion text is a separately hand-written
 * literal, so if a future edit changes INVENTORY_EXPORT_HEADERS, the header
 * line this route emits changes too and the literal comparison fails —
 * that's the column-drift pin.
 */
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilterFor: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return { ...actual, buildInventoryExportRows: vi.fn() };
});

import { GET } from './route';

const ROW = {
  name: 'Lenovo 300e',
  sku: 'SP-1',
  barcode: 'BC1',
  item_type: 'product',
  status: 'active',
  quantity_on_hand: 100,
  reorder_point: 5,
  reorder_quantity: 0,
  unit_cost: 10,
  retail_price: 20,
  category: 'Electronics',
  primary_location: 'DC4',
  supplier: 'Acme',
  warehouse: 'North WH',
  // Null charter_id -> formatCharterCell() -> 'Generic' (the R1 delta).
  charter: 'Generic',
  tracking_type: 'none',
  author: '',
  isbn: '',
  grade: '',
  rack_number: '',
  rack_row: '',
  crate_color: '',
  crate_number: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const CHARTER_COLUMN_INDEX = INVENTORY_EXPORT_HEADERS.indexOf('charter');

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' = 'admin') {
  const stub = makeSupabaseStub();
  return makeServiceContext(stub.client, { role });
}

function buildRequest(query = ''): Request {
  return new Request(`https://test.local/api/inventory/export.csv${query}`, { method: 'GET' });
}

/** The `filters` object the route handed buildInventoryExportRows. */
function lastFilters() {
  const call = vi.mocked(buildInventoryExportRows).mock.calls.at(-1);
  return (call?.[1] as { filters?: { warehouseId?: string | null } } | undefined)?.filters;
}

beforeEach(() => {
  vi.mocked(getActiveWarehouseFilterFor).mockResolvedValue(null);
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  vi.mocked(buildInventoryExportRows).mockResolvedValue({
    headers: [...INVENTORY_EXPORT_HEADERS],
    rows: [ROW],
    total: 1,
    truncated: false,
    slug: 'inventory',
  } as never);
});

describe('GET /api/inventory/export.csv — authorization', () => {
  it('401s without a context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('403s for a role without items:export', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx('viewer'));
    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
  });
});

describe('GET /api/inventory/export.csv — column and charter fidelity', () => {
  it('pins the exact 25-column header row', async () => {
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const headerLine = (await res.text()).split('\n')[0];
    expect(headerLine).toBe(
      'name,sku,barcode,item_type,status,quantity_on_hand,reorder_point,reorder_quantity,' +
        'unit_cost,retail_price,category,primary_location,supplier,warehouse,charter,' +
        'tracking_type,author,isbn,grade,rack_number,rack_row,crate_color,crate_number,' +
        'created_at,updated_at',
    );
    expect(headerLine!.split(',')).toHaveLength(25);
  });

  it('renders a null-charter row as "Generic" (the R1 delta)', async () => {
    const res = await GET(buildRequest());
    const dataLine = (await res.text()).split('\n')[1]!;
    expect(dataLine.split(',')[CHARTER_COLUMN_INDEX]).toBe('Generic');
  });

  it('renders a failed charter LOOKUP as blank, never "Generic" (the honesty line)', async () => {
    vi.mocked(buildInventoryExportRows).mockResolvedValueOnce({
      headers: [...INVENTORY_EXPORT_HEADERS],
      rows: [{ ...ROW, charter: '' }],
      total: 1,
      truncated: false,
      slug: 'inventory',
    } as never);
    const res = await GET(buildRequest());
    const dataLine = (await res.text()).split('\n')[1]!;
    expect(dataLine.split(',')[CHARTER_COLUMN_INDEX]).toBe('');
    expect(dataLine).not.toMatch(/Generic/);
  });
});

/**
 * SP-119b. The AI `exportInventory` tool could only ever hand the user a link
 * to THIS route, and the route read its warehouse from the dashboard cookie
 * alone — so a tool that had narrowed its count probe to one warehouse linked
 * a file covering every warehouse ("[Download 413 items]" over an all-org
 * CSV). The route now accepts an explicit `?warehouseId=` so a non-browser
 * caller can scope the download the same way the selector does.
 */
describe('GET /api/inventory/export.csv — ?warehouseId scoping', () => {
  const WH = '11111111-2222-3333-4444-555555555555';

  it('passes an explicit ?warehouseId through to the export query', async () => {
    const res = await GET(buildRequest(`?warehouseId=${WH}`));
    expect(res.status).toBe(200);
    expect(lastFilters()?.warehouseId).toBe(WH);
  });

  it('an explicit ?warehouseId wins over the dashboard cookie', async () => {
    vi.mocked(getActiveWarehouseFilterFor).mockResolvedValue('99999999-9999-9999-9999-999999999999');
    await GET(buildRequest(`?warehouseId=${WH}`));
    expect(lastFilters()?.warehouseId).toBe(WH);
  });

  it('falls back to the cookie filter when the param is absent (unchanged behaviour)', async () => {
    vi.mocked(getActiveWarehouseFilterFor).mockResolvedValue(WH);
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    expect(lastFilters()?.warehouseId).toBe(WH);
  });

  it('exports unfiltered when neither the param nor the cookie is set', async () => {
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    expect(lastFilters()?.warehouseId).toBeNull();
  });

  it('refuses a non-uuid ?warehouseId with 400 rather than silently exporting everything', async () => {
    const before = vi.mocked(buildInventoryExportRows).mock.calls.length;
    const res = await GET(buildRequest('?warehouseId=north'));
    expect(res.status).toBe(400);
    // Refuse, never fall back to "no filter" — a silent fallback is exactly
    // how the caller ends up promising one warehouse and shipping all of them.
    expect(vi.mocked(buildInventoryExportRows).mock.calls.length).toBe(before);
  });

  it('treats an empty ?warehouseId= as absent, not as invalid', async () => {
    const res = await GET(buildRequest('?warehouseId='));
    expect(res.status).toBe(200);
    expect(lastFilters()?.warehouseId).toBeNull();
  });
});
