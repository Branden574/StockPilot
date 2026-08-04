import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportSourceRows } from '@/lib/inventory-export';
import { countRowsWithImages } from '@/lib/exports/export-images';
import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilterFor: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return { ...actual, buildInventoryExportSourceRows: vi.fn() };
});
vi.mock('@/lib/exports/export-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exports/export-images')>();
  return { ...actual, countRowsWithImages: vi.fn(async () => 0), attachExportImages: vi.fn() };
});

import { POST } from './route';

function buildCtx(role: 'admin' | 'viewer') {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://test.local/api/inventory/export/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

// DEVIATION (recorded, same convention as inventory-export-xlsx.test.ts /
// export-csv.test.ts / field-registry.test.ts / export-images.test.ts and
// route.test.tsx's own SOURCE_ROW in this task): the brief's sourceRow()
// fixture omits `legacyRawBookFields`, a NON-OPTIONAL field of
// InventoryExportSourceRow (source-row.ts). Typecheck fails without it, so it
// is added here.
function sourceRow(id: string, isbn: string) {
  return {
    id,
    itemType: 'book',
    name: `Book ${id}`,
    sku: `BK-${id}`,
    barcode: isbn,
    status: 'active',
    quantityOnHand: 1,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: null,
    retailPrice: null,
    category: '',
    primaryLocation: '',
    supplier: '',
    warehouse: '',
    charter: 'Generic',
    trackingType: 'none',
    author: '',
    isbn,
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    // A REAL signed image, not null: without this, the preview route's
    // image-nulling (`.map((r) => ({ ...r, image: null })`) has nothing to
    // strip, and 'never returns an image URL in the sample rows' below would
    // pass even if that line were deleted (Fix wave 1, tautological-guard
    // finding). The shape mirrors InventoryExportImage exactly (source-row.ts)
    // — thumbnailUrl only, no masterUrl field exists on that type.
    image: { thumbnailUrl: `https://cdn.example.com/covers/${id}.jpg?token=SECRET` },
    legacyRawBookFields: {
      grade: '',
      rackNumber: '',
      rackRow: '',
      crateColor: '',
      crateNumber: '',
    },
  };
}

beforeEach(() => {
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  vi.mocked(countRowsWithImages).mockResolvedValue(0);
  vi.mocked(buildInventoryExportSourceRows).mockResolvedValue({
    rows: Array.from({ length: 25 }, (_, i) => sourceRow(`i${i}`, i < 20 ? `978026203384${i % 10}` : '')),
    total: 25,
    truncated: false,
    slug: 'books',
  } as never);
});

describe('POST /api/inventory/export/preview', () => {
  it('401s without a context and 403s without items:export', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await POST(buildRequest({ scope: 'all' }))).status).toBe(401);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('viewer'));
    expect((await POST(buildRequest({ scope: 'all' }))).status).toBe(403);
  });

  it('returns at most 10 sample rows regardless of the result size', async () => {
    const res = await POST(buildRequest({ scope: 'all', itemType: 'book' }));
    const body = await res.json();
    expect(body.sampleRows).toHaveLength(10);
    expect(body.total).toBe(25);
  });

  it('counts ISBN readiness across the WHOLE result, not just the sample', async () => {
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    expect(body.readiness.rows).toBe(25);
    expect(body.readiness.withIsbn).toBe(20);
    expect(body.readiness.missingIsbn).toBe(5);
  });

  it('counts cover readiness through the no-signing counter', async () => {
    vi.mocked(countRowsWithImages).mockResolvedValueOnce(18);
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    expect(body.readiness.withImage).toBe(18);
    expect(body.readiness.missingImage).toBe(7);
  });

  it('never returns an image URL in the sample rows', async () => {
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    for (const row of body.sampleRows) expect(row.image).toBeNull();
    expect(JSON.stringify(body)).not.toContain('token=');
  });

  it('400s a selected preview with no ids', async () => {
    expect((await POST(buildRequest({ scope: 'selected', ids: [] }))).status).toBe(400);
  });
});
