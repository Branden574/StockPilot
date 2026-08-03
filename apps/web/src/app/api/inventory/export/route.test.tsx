import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportRows } from '@/lib/inventory-export';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The unified export route had ZERO test coverage before this file (Audit D1),
 * which is precisely why a PDF with no ISBN column shipped unnoticed.
 *
 * renderToStream is mocked so the suite can assert on the ELEMENT handed to
 * react-pdf — the column set is the thing under test, and rendering a real PDF
 * to compare bytes would assert nothing readable. The mock must also supply
 * StyleSheet.create, because report-table.tsx and styles.ts both call it at
 * module load.
 */
let capturedElement: { props: Record<string, unknown> } | null = null;

vi.mock('@react-pdf/renderer', () => ({
  renderToStream: vi.fn(async (element: { props: Record<string, unknown> }) => {
    capturedElement = element;
    return Readable.from([Buffer.from('%PDF-1.7\n')]);
  }),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Document: 'Document',
  Page: 'Page',
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  Font: { register: () => {} },
}));

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

import { POST } from './route';

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  const stub = makeSupabaseStub({
    // A real `.maybeSingle()` call resolves to a SINGLE row object (or null),
    // never an array — the fixture now matches that shape exactly instead of
    // relying on makeSupabaseStub's array-unwrap leniency for `.maybeSingle()`
    // to make an array-shaped fixture behave as intended (fixture fidelity).
    'organizations.select': { data: { name: 'Demo Co', logo_url: null }, error: null },
  });
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://test.local/api/inventory/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const BOOK_ROW = {
  name: 'Introduction to Algorithms',
  sku: 'BK-0001',
  barcode: '9780262033848',
  item_type: 'book',
  status: 'active',
  quantity_on_hand: 4,
  reorder_point: 0,
  reorder_quantity: 0,
  unit_cost: 42,
  retail_price: 89,
  category: 'Mathematics',
  primary_location: 'DC4',
  supplier: '',
  warehouse: 'North',
  charter: 'Generic',
  tracking_type: 'none',
  author: 'Cormen',
  isbn: '9780262033848',
  grade: 'College',
  rack_number: '38',
  rack_row: 'A',
  crate_color: 'blue',
  crate_number: '12',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  capturedElement = null;
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  vi.mocked(buildInventoryExportRows).mockResolvedValue({
    headers: ['name', 'sku', 'isbn', 'quantity_on_hand', 'category', 'primary_location', 'charter', 'status'],
    rows: [BOOK_ROW],
    total: 1,
    truncated: false,
    slug: 'books',
  } as never);
});

function pdfColumns(): Array<{ key: string; label: string }> {
  const sections = (capturedElement?.props.sections ?? []) as Array<{
    columns: Array<{ key: string; label: string }>;
  }>;
  return sections[0]?.columns ?? [];
}

describe('POST /api/inventory/export — authorization', () => {
  it('401s without a context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await POST(buildRequest({ format: 'csv', scope: 'all' }));
    expect(res.status).toBe(401);
  });

  it('403s for a role without items:export', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx('viewer'));
    const res = await POST(buildRequest({ format: 'csv', scope: 'all' }));
    expect(res.status).toBe(403);
  });

  it('400s a selected export with no ids', async () => {
    const res = await POST(buildRequest({ format: 'csv', scope: 'selected', ids: [] }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/inventory/export — the Books PDF carries ISBN', () => {
  it('includes an ISBN column for a books export', async () => {
    const res = await POST(
      buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }),
    );
    expect(res.status).toBe(200);
    expect(pdfColumns().map((c) => c.key)).toContain('isbn');
    // The resolved org name (fixture: buildCtx's 'organizations.select' stub)
    // reaches the PDF as a prop, not just a placeholder fallback.
    expect(capturedElement?.props.orgName).toBe('Demo Co');
  });

  it('puts ISBN right after the title and SKU, where a book is identified', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    const keys = pdfColumns().map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(['name', 'sku', 'isbn']);
  });

  it('keeps ON HAND and CATEGORY as two separate columns', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    const keys = pdfColumns().map((c) => c.key);
    expect(keys).toContain('quantity_on_hand');
    expect(keys).toContain('category');
    expect(keys.filter((k) => k === 'quantity_on_hand')).toHaveLength(1);
    // No merged "On hand / Category" column may ever exist (Brief section 13).
    for (const col of pdfColumns()) {
      expect(col.label).not.toMatch(/on hand.*categor/i);
    }
  });

  it('gives every PDF column a point minimum so headers cannot collide', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    for (const col of pdfColumns() as Array<{ key: string; minWidth?: number }>) {
      expect(col.minWidth, `${col.key} has no minWidth`).toBeGreaterThan(0);
    }
  });

  it('does NOT put ISBN on a non-book export', async () => {
    vi.mocked(buildInventoryExportRows).mockResolvedValue({
      headers: ['name', 'sku'],
      rows: [{ ...BOOK_ROW, item_type: 'product', isbn: '' }],
      total: 1,
      truncated: false,
      slug: 'inventory',
    } as never);
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'product' }));
    expect(pdfColumns().map((c) => c.key)).not.toContain('isbn');
  });
});

describe('POST /api/inventory/export — CSV still works', () => {
  it('returns the canonical CSV with the Generic charter value intact', async () => {
    const res = await POST(buildRequest({ format: 'csv', scope: 'all', itemType: 'book' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('isbn');
    expect(text).toContain('Generic');
    expect(res.headers.get('Content-Disposition')).toContain('books-all-');
  });
});
