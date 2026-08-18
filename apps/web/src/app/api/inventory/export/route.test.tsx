import { Readable } from 'node:stream';

import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportSourceRows } from '@/lib/inventory-export';
import {
  attachExportImages,
  EXPORT_IMAGE_TARGET_WIDTH_PX,
  fetchExportImageBytes,
} from '@/lib/exports/export-images';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
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
// DEVIATION (Task 13, recorded): the brief's Step 1 instructs mocking
// buildInventoryExportRows AND buildInventoryExportSourceRows, but this file
// only ever imports/uses buildInventoryExportSourceRows now — the rewritten
// route no longer calls buildInventoryExportRows at all (that function is the
// legacy .csv route's own concern, exercised by its own test file). Mocking a
// name this file never imports or asserts on would be dead weight, so only
// buildInventoryExportSourceRows is mocked here. The mock factory still
// spreads `...actual` first so the legacy export keeps working for anything
// else in the module graph.
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return { ...actual, buildInventoryExportSourceRows: vi.fn() };
});
vi.mock('@/lib/exports/export-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exports/export-images')>();
  return {
    ...actual,
    attachExportImages: vi.fn(async () => {}),
    fetchExportImageBytes: vi.fn(async () => ({
      images: new Map(),
      skipped: 0,
      truncated: false,
      skippedReasons: { rateLimited: 0, timeout: 0, unsupported: 0, oversized: 0, other: 0, deadline: 0 },
    })),
  };
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

// SOURCE_ROW: a well-formed InventoryExportSourceRow (Task 6 shape), used as
// the default stub for buildInventoryExportSourceRows across every test in
// this file (both the pre-existing Phase-A suites below and the Task 13
// suites appended at the end).
//
// DEVIATION (recorded, matches the pattern already used by
// inventory-export-xlsx.test.ts / export-csv.test.ts / field-registry.test.ts
// / export-images.test.ts): the brief's own SOURCE_ROW fixture omits
// `legacyRawBookFields`, a NON-OPTIONAL field of InventoryExportSourceRow
// (source-row.ts). Typecheck fails without it. Added here following the same
// convention as those other Task 11/12 test files.
const SOURCE_ROW = {
  id: 'i-1',
  itemType: 'book',
  name: 'Introduction to Algorithms',
  sku: 'BK-0001',
  barcode: '9780262033848',
  status: 'active',
  quantityOnHand: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitCost: 42,
  retailPrice: 89,
  category: 'Mathematics',
  primaryLocation: 'DC4',
  supplier: '',
  warehouse: 'North',
  charter: 'Generic',
  trackingType: 'none',
  author: 'Cormen',
  isbn: '9780262033848',
  grade: 'College',
  rackNumber: '38',
  rackRow: 'A',
  crateColor: 'blue',
  crateNumber: '12',
  rackLabel: '38-A',
  crateLabel: 'Blue 12',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  image: null,
  legacyRawBookFields: {
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
  },
};

function stubSourceRows(overrides: Record<string, unknown> = {}) {
  vi.mocked(buildInventoryExportSourceRows).mockResolvedValue({
    rows: [SOURCE_ROW],
    total: 1,
    truncated: false,
    slug: 'books',
    ...overrides,
  } as never);
}

beforeEach(() => {
  capturedElement = null;
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  stubSourceRows();
});

// DEVIATION (recorded): reads `capturedElement.props.layout.columns` instead
// of the pre-Task-13 `props.sections[0].columns` — the route now renders
// InventoryExportPdf (Task 9/10), whose prop is `layout`, not ReportTablePdf's
// `sections`. Every pre-existing test in the "Books PDF carries ISBN"
// describe block below shares this one helper, so updating it here is what
// the brief's Step 5 note ("update those three ... to read
// capturedElement.props.layout.columns") means in practice.
function pdfColumns(): Array<{ key: string; label: string; widthPt: number }> {
  const layout = (capturedElement?.props.layout ?? { columns: [] }) as {
    columns: Array<{ key: string; label: string; widthPt: number }>;
  };
  return layout.columns;
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

  // DEVIATION (recorded): the brief's pre-existing literal here is
  // ['name', 'sku', 'isbn'] — the order the OLD ReportTablePdf column arrays
  // (inventory-pdf-columns.ts, deleted in this task's Step 4) happened to
  // use. The shipped Task 5 registry's canonical default book field order
  // (field-registry.ts BOOKS_DEFAULT_FIELD_KEYS, Brief section 8) is
  // image, name, isbn, sku, author, ... — ISBN before SKU. Since this test
  // requests no explicit `fields`, the route falls back to that registry
  // default, so the true post-Task-13 order is ['name', 'isbn', 'sku']. This
  // is the same class of transcription slip as the documented Task 12
  // 'Name' vs 'Title' adjudication: the registry is the source of truth, so
  // the test literal is fixed to match it rather than upstream code bent to
  // match a stale literal.
  it('puts ISBN right after the title, where a book is identified', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    const keys = pdfColumns().map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(['name', 'isbn', 'sku']);
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

  // DEVIATION (recorded): the brief's pre-existing assertion reads
  // `col.minWidth`, a property of the OLD ReportTablePdf column shape
  // (inventory-pdf-columns.ts). The NEW `ExportPdfColumn` (pdf-layout.ts,
  // Task 8) has no `minWidth` field at all — it carries the already-resolved
  // `widthPt`, and the "headers cannot collide" guarantee this test exists to
  // check is now enforced upstream by computeExportPdfLayout's identifier
  // reservation + fitColumnWidths (never producing a non-positive width for a
  // rendered column). Reading `widthPt` is the equivalent check against the
  // shipped shape.
  it('gives every PDF column a positive width so headers cannot collide', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    for (const col of pdfColumns()) {
      expect(col.widthPt, `${col.key} has no width`).toBeGreaterThan(0);
    }
  });

  it('does NOT put ISBN on a non-book export', async () => {
    stubSourceRows({
      rows: [{ ...SOURCE_ROW, itemType: 'product', isbn: '' }],
      slug: 'inventory',
    });
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'product' }));
    expect(pdfColumns().map((c) => c.key)).not.toContain('isbn');
  });
});

describe('POST /api/inventory/export — CSV still works', () => {
  // DEVIATION (recorded): the brief's pre-existing literal here asserts the
  // CSV body contains 'Generic' (the fixture row's charter value) — a
  // holdover from when this describe block exercised the LEGACY fixed
  // 25-column buildInventoryExportRows projection, which always included
  // charter. The bare request below (no `fields`) now resolves through the
  // Task 5 registry's default BOOK field list (field-registry.ts
  // BOOKS_DEFAULT_FIELD_KEYS, Brief section 8), which deliberately does not
  // include charter — that is the shipped, intentional default, not a
  // regression (books-full-detail vs. items exports differ on purpose). The
  // assertion is swapped for one the new default set actually carries — the
  // row's ISBN — to keep testing the same thing ("a real row survives the
  // request with no `fields` specified, exactly what the two pre-Phase-D
  // export buttons send today") without pinning a column the endpoint never
  // promises for this default.
  it('returns a real CSV for the pre-builder (no-fields) request shape', async () => {
    const res = await POST(buildRequest({ format: 'csv', scope: 'all', itemType: 'book' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('ISBN');
    expect(text).toContain('9780262033848');
    expect(res.headers.get('Content-Disposition')).toContain('books-all-');
  });
});

describe('POST /api/inventory/export — the field list is honoured and validated', () => {
  it('exports exactly the requested fields, in the requested order, in CSV', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'all',
        itemType: 'book',
        fields: ['isbn', 'name', 'quantity_on_hand'],
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('ISBN,Title,On hand');
  });

  it('400s an unknown field instead of silently dropping it', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({ format: 'csv', scope: 'all', fields: ['name', 'sneaky_field'] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('sneaky_field');
  });

  it('400s a field list with no identifying column', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({ format: 'csv', scope: 'all', fields: ['quantity_on_hand'] }),
    );
    expect(res.status).toBe(400);
  });

  it('400s the catalog layout for a non-book export', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'product',
        fields: ['name'],
        options: { pdf: { layout: 'catalog' } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('does NO image work when the image field was not selected', async () => {
    stubSourceRows();
    await POST(buildRequest({ format: 'csv', scope: 'all', fields: ['name', 'sku'] }));
    expect(vi.mocked(attachExportImages)).not.toHaveBeenCalled();
  });

  it('resolves images exactly once when the image field IS selected', async () => {
    stubSourceRows();
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['image', 'name'],
        options: { includeImages: true, imageSize: 'large' },
      }),
    );
    expect(vi.mocked(attachExportImages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(attachExportImages).mock.calls[0]![2]).toEqual({ imageSize: 'large' });
  });

  it('names the file from the preset when one was given', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'xlsx',
        scope: 'all',
        itemType: 'book',
        fields: ['name', 'isbn'],
        options: { presetName: 'Books ISBN list' },
      }),
    );
    expect(res.headers.get('Content-Disposition')).toContain('books-isbn-list-');
  });

  it('names a selected export with its record count', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'selected',
        itemType: 'all',
        ids: ['11111111-1111-1111-1111-111111111111'],
        fields: ['name'],
      }),
    );
    expect(res.headers.get('Content-Disposition')).toContain('-selected-1-item-');
  });

  it('still applies the warehouse filter on the filtered scope only', async () => {
    stubSourceRows();
    await POST(buildRequest({ format: 'csv', scope: 'all', fields: ['name'] }));
    expect(vi.mocked(getActiveWarehouseFilterFor)).not.toHaveBeenCalled();
    await POST(buildRequest({ format: 'csv', scope: 'filtered', fields: ['name'] }));
    expect(vi.mocked(getActiveWarehouseFilterFor)).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved layout to the PDF document, columns in order', async () => {
    stubSourceRows();
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['name', 'isbn', 'quantity_on_hand'],
        options: { pdf: { orientation: 'landscape', paperSize: 'legal' } },
      }),
    );
    const layout = capturedElement!.props.layout as {
      columns: Array<{ key: string }>;
      pageWidthPt: number;
    };
    expect(layout.columns.map((c) => c.key)).toEqual(['name', 'isbn', 'quantity_on_hand']);
    expect(layout.pageWidthPt).toBe(1008);
  });
});

// ADDITIVE (Fix wave 1, not in the brief's verbatim suite): pins the CSV
// imageMode coercion's narrowness — it must fire ONLY when the client sent
// neither `fields` nor an explicit `options.imageMode`. Without these, a
// client that explicitly asks for 'embedded' on a CSV export would be
// silently downgraded to 'url' instead of getting the 400 that tells them
// CSV cannot embed images.
describe('POST /api/inventory/export — CSV imageMode coercion is narrow', () => {
  it('400s an explicit fields+embedded CSV request instead of silently downgrading it', async () => {
    stubSourceRows();
    // No explicit `options.imageMode` here on purpose: the schema default is
    // already 'embedded' (export-request.ts), so the PARSED request is
    // identical either way, but sending it explicitly would ALSO trip the
    // clientSentImageMode gate and mask whether the `!parsed.data.fields`
    // gate alone is doing its job — this body isolates that gate: an
    // explicit field list (containing `image`) must still be rejected on
    // CSV, the same as it always was, and the coercion must never touch it.
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'all',
        itemType: 'book',
        fields: ['image', 'name'],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s a bare CSV request (no fields) that explicitly asks for embedded images', async () => {
    stubSourceRows();
    // itemType: 'book' so the registry default field list actually leads with
    // `image` (BOOKS_DEFAULT_FIELD_KEYS) — the 'all'/'other' default list
    // omits image entirely, which would make imagesRequested false and the
    // request pass with no rejection regardless of imageMode, testing nothing.
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'all',
        itemType: 'book',
        options: { imageMode: 'embedded' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('still lets the bare pre-builder CSV request (no fields, no options) through at 200', async () => {
    stubSourceRows();
    const res = await POST(buildRequest({ format: 'csv', scope: 'all', itemType: 'book' }));
    expect(res.status).toBe(200);
  });
});

// ADDITIVE (Task 13 test-hygiene sweep, not in the brief's verbatim suite):
// none of the brief's own tests assert Content-Type or the file EXTENSION in
// Content-Disposition per format — every one of them checks status/body/a
// filename SUBSTRING. A self-mutation-check (swap the csv/xlsx/pdf
// Content-Type strings, or the filename extension) would slip through
// unnoticed by the suite above, so this pins the three response headers
// downstream code (download-export.ts's Content-Disposition filename parse,
// and any browser/email client sniffing Content-Type) actually depends on.
describe('POST /api/inventory/export — response headers match the format', () => {
  it('csv: text/csv content type and a .csv filename', async () => {
    stubSourceRows();
    const res = await POST(buildRequest({ format: 'csv', scope: 'all', fields: ['name'] }));
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/filename="[^"]+\.csv"$/);
  });

  it('xlsx: the OOXML spreadsheet content type and a .xlsx filename', async () => {
    stubSourceRows();
    const res = await POST(buildRequest({ format: 'xlsx', scope: 'all', fields: ['name'] }));
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('Content-Disposition')).toMatch(/filename="[^"]+\.xlsx"$/);
  });

  it('pdf: application/pdf content type and a .pdf filename', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({ format: 'pdf', scope: 'all', itemType: 'book', fields: ['name'] }),
    );
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/filename="[^"]+\.pdf"$/);
  });
});

// 2026-08-18: the PDF branch used to hand react-pdf signed URLs to fetch on its
// own (no retry, no rate gate) — the same transform endpoint whose 429s left
// Excel cells blank. Both branches now go through fetchExportImageBytes and
// the PDF document receives BYTES; Excel additionally reports what was skipped.
describe('POST /api/inventory/export — images are fetched once, as bytes, and skips are surfaced', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const fetched = () => vi.mocked(fetchExportImageBytes);

  it('pdf: calls fetchExportImageBytes with the tier width and hands the document { data, format } — never a URL', async () => {
    stubSourceRows({ rows: [{ ...SOURCE_ROW, image: { thumbnailUrl: 'https://signed.example/a.webp' } }] });
    fetched().mockResolvedValueOnce({
      images: new Map([['i-1', { data: PNG, extension: 'png' }]]),
      skipped: 0,
      truncated: false,
      skippedReasons: { rateLimited: 0, timeout: 0, unsupported: 0, oversized: 0, other: 0, deadline: 0 },
    });
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['image', 'name'],
        options: { includeImages: true, imageSize: 'large' },
      }),
    );
    expect(fetched()).toHaveBeenCalledTimes(1);
    const [urls, opts] = fetched().mock.calls[0]!;
    expect(urls.get('i-1')).toBe('https://signed.example/a.webp');
    expect(opts?.targetWidth).toBe(EXPORT_IMAGE_TARGET_WIDTH_PX.large);
    const rows = capturedElement!.props.rows as Array<{ imageSrc: unknown }>;
    const src = rows[0]!.imageSrc as { data: Buffer; format: string };
    expect(typeof src).toBe('object');
    expect(Buffer.isBuffer(src.data)).toBe(true);
    expect(src.format).toBe('png');
    expect(JSON.stringify(rows)).not.toContain('signed.example');
  });

  it('pdf: does NOT fetch bytes when images are off', async () => {
    stubSourceRows();
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['name'],
        options: { includeImages: false },
      }),
    );
    expect(fetched()).not.toHaveBeenCalled();
  });

  it('xlsx: forwards the skipped count into the Summary sheet as Images not embedded', async () => {
    stubSourceRows({
      rows: [
        { ...SOURCE_ROW, id: 'i-1', image: { thumbnailUrl: 'https://signed.example/1.webp' } },
        { ...SOURCE_ROW, id: 'i-2', image: { thumbnailUrl: 'https://signed.example/2.webp' } },
        { ...SOURCE_ROW, id: 'i-3', image: { thumbnailUrl: 'https://signed.example/3.webp' } },
      ],
      total: 3,
    });
    fetched().mockResolvedValueOnce({
      images: new Map([['i-1', { data: PNG, extension: 'png' }]]),
      skipped: 2,
      truncated: false,
      skippedReasons: { rateLimited: 2, timeout: 0, unsupported: 0, oversized: 0, other: 0, deadline: 0 },
    });
    const res = await POST(
      buildRequest({
        format: 'xlsx',
        scope: 'all',
        itemType: 'book',
        fields: ['image', 'name'],
        options: {
          includeImages: true,
          imageMode: 'embedded',
          imageSize: 'medium',
          xlsx: { includeSummarySheet: true },
        },
      }),
    );
    expect(res.status).toBe(200);
    const [, opts] = fetched().mock.calls[0]!;
    expect(opts?.targetWidth).toBe(EXPORT_IMAGE_TARGET_WIDTH_PX.medium);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const summary = wb.getWorksheet('Summary')!;
    expect(summary).toBeDefined();
    const text = JSON.stringify(summary.getSheetValues());
    expect(text).toContain('Images not embedded');
    expect(text).toContain(
      '2 of 3 images could not be fetched and were left blank. Re-run the export to retry.',
    );
  });
});
