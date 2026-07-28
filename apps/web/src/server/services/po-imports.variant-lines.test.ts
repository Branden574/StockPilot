import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Task 13: BOTH line-payload mappers must persist the variant columns.
 *
 * There are two independent writers into po_import_lines — createFromScan
 * (AI) and parseImport (deterministic CSV/PDF). A column added to one and not
 * the other makes a scanned PO and an uploaded PO of the SAME document
 * disagree, so each is asserted separately here.
 */

const { mockAudit, mockParsePoFile, mockExtract, mockAdmin } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockParsePoFile: vi.fn(),
  mockExtract: vi.fn(),
  mockAdmin: vi.fn(),
}));

vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: mockParsePoFile }));
vi.mock('@/lib/po-scan/extract', () => ({
  extractPoFromMedia: mockExtract,
  SCAN_MODEL_NAME: 'claude-sonnet-5',
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdmin }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-variant-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.mockReturnValue({
    storage: {
      from: () => ({
        upload: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }),
    },
  });
});

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      organizationId: 'org-1',
      enabledModules: new Set<ModuleId>(['po_imports']),
    }),
  );
}

function insertedLines(stub: ReturnType<typeof makeSupabaseStub>): Array<Record<string, unknown>> {
  return (stub.chainArgs.get('po_import_lines.insert')?.[0]?.[0] ?? []) as Array<
    Record<string, unknown>
  >;
}

// ── createFromScan (AI path) ────────────────────────────────────────────────

function scanStub() {
  const stub = makeSupabaseStub({
    'po_imports.select': { data: [], error: null },
    'po_imports.insert': { data: { id: IMPORT_ID }, error: null },
    'po_imports.update': { data: [], error: null },
    'purchase_orders.select': { data: [], error: null },
    'vendor_item_mappings.select': { data: [], error: null },
    'po_import_lines.insert': { data: null, error: null },
  });
  return stub;
}

function extractedLine(extra: Record<string, unknown> = {}) {
  return {
    lineNumber: 1,
    description: 'Falcons Home Jersey - M',
    vendorSku: 'FHJ-M',
    quantity: 3,
    uom: 'EA',
    unitPrice: 42,
    lineTotal: 126,
    lineType: 'inventory',
    confidence: 0.95,
    size: '',
    sizeSystem: '',
    width: '',
    colorway: '',
    jerseyNumber: '',
    playerName: '',
    groupHint: '',
    mappingConfidence: null,
    ...extra,
  };
}

function extractedPo(lines: Array<Record<string, unknown>>) {
  return {
    poNumber: 'PO-77',
    vendorName: 'Team Outfitters',
    vendorAddress: '',
    orderDate: '',
    expectedDate: '',
    subtotal: 0,
    tax: 0,
    freight: 0,
    grandTotal: 0,
    overallConfidence: 0.95,
    lines,
  };
}

const FILES = [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', fileName: 'po.jpg' }];

describe('createFromScan — variant columns reach po_import_lines', () => {
  it('writes every extracted variant field onto the line', async () => {
    mockExtract.mockResolvedValue(
      extractedPo([
        extractedLine({
          size: 'M',
          sizeSystem: 'ALPHA',
          width: '2E',
          colorway: 'Red/Black',
          jerseyNumber: '07',
          playerName: 'A. Rosas',
          groupHint: 'Falcons Home Jersey 2026',
          mappingConfidence: 0.62,
        }),
      ]),
    );
    const stub = scanStub();

    await svc(stub).createFromScan({ files: FILES });

    const line = insertedLines(stub)[0]!;
    expect(line.variant_size).toBe('M');
    // The size as PRINTED is preserved alongside the working value.
    expect(line.variant_size_original).toBe('M');
    expect(line.variant_size_system).toBe('ALPHA');
    expect(line.variant_width).toBe('2E');
    expect(line.variant_color).toBe('Red/Black');
    expect(line.jersey_number).toBe('07');
    expect(line.player_name).toBe('A. Rosas');
    expect(line.group_hint).toBe('Falcons Home Jersey 2026');
    expect(line.mapping_confidence).toBe(0.62);
    // Advisory only, and never invented by the extractor.
    expect(line.suggested_group_id).toBeNull();
  });

  it('writes NULL, not empty string, when the document said nothing', async () => {
    mockExtract.mockResolvedValue(extractedPo([extractedLine()]));
    const stub = scanStub();

    await svc(stub).createFromScan({ files: FILES });

    const line = insertedLines(stub)[0]!;
    for (const col of [
      'variant_size',
      'variant_size_original',
      'variant_size_system',
      'variant_width',
      'variant_fit',
      'variant_color',
      'jersey_number',
      'player_name',
      'group_hint',
      'suggested_group_id',
      'mapping_confidence',
    ]) {
      expect(line[col]).toBeNull();
    }
  });

  it('keeps a leading-zero jersey number as text on the insert payload', async () => {
    mockExtract.mockResolvedValue(
      extractedPo([
        extractedLine({ lineNumber: 1, jerseyNumber: '00' }),
        extractedLine({ lineNumber: 2, jerseyNumber: '07' }),
        extractedLine({ lineNumber: 3, jerseyNumber: '0' }),
      ]),
    );
    const stub = scanStub();

    await svc(stub).createFromScan({ files: FILES });

    expect(insertedLines(stub).map((l) => l.jersey_number)).toEqual(['00', '07', '0']);
    for (const l of insertedLines(stub)) expect(typeof l.jersey_number).toBe('string');
  });
});

// ── parseImport (deterministic CSV/PDF path) ────────────────────────────────

function canonicalLine(extra: Record<string, unknown> = {}) {
  return {
    lineNumber: 1,
    lineType: 'inventory',
    qtyOrderedOriginal: 3,
    uomOriginal: 'EA',
    description: 'Nike Pegasus 41 - 10.5',
    unitCost: 89.99,
    lineTotal: 269.97,
    vendorItemNumber: 'FD2722',
    vendorProductNumber: null,
    auxiliaryNumber: null,
    coaCode: null,
    ...extra,
  };
}

function parseStub() {
  const stub = makeSupabaseStub({
    'po_imports.select': {
      data: { id: IMPORT_ID, source_type: 'csv', storage_path: 'org-1/po-imports/f.csv', vendor_id: null },
      error: null,
    },
    'po_imports.update': { data: { id: IMPORT_ID }, error: null },
    'vendor_item_mappings.select': { data: [], error: null },
    'po_import_lines.insert': { data: null, error: null },
  });
  stub.client.storage.from = vi.fn(() => ({
    download: vi.fn(async () => ({
      data: { arrayBuffer: async () => new ArrayBuffer(0) },
      error: null,
    })),
  })) as never;
  return stub;
}

describe('parseImport — variant columns reach po_import_lines', () => {
  it('writes the canonical variant fields onto the line', async () => {
    mockParsePoFile.mockResolvedValue({
      poNumber: 'PO-9',
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
      rawText: 'raw',
      lines: [
        canonicalLine({
          variantSize: '10.5',
          variantSizeOriginal: 'US 10 1/2',
          variantSizeSystem: 'US_MENS',
          variantWidth: '2E',
          variantFit: 'mens',
          variantColor: 'Black/White',
          jerseyNumber: '07',
          playerName: 'A. Rosas',
          groupHint: 'Nike Pegasus 41 FD2722',
          mappingConfidence: 0.9,
        }),
      ],
    });
    const stub = parseStub();

    await svc(stub).parseImport(IMPORT_ID);

    const line = insertedLines(stub)[0]!;
    expect(line.variant_size).toBe('10.5');
    // The parser gave a DIFFERENT original — it must not be overwritten.
    expect(line.variant_size_original).toBe('US 10 1/2');
    expect(line.variant_size_system).toBe('US_MENS');
    expect(line.variant_width).toBe('2E');
    expect(line.variant_fit).toBe('mens');
    expect(line.variant_color).toBe('Black/White');
    expect(line.jersey_number).toBe('07');
    expect(line.player_name).toBe('A. Rosas');
    expect(line.group_hint).toBe('Nike Pegasus 41 FD2722');
    expect(line.mapping_confidence).toBe(0.9);
  });

  it('a pre-sports parser line (no variant keys at all) writes NULLs and still imports', async () => {
    mockParsePoFile.mockResolvedValue({
      poNumber: 'PO-9',
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
      rawText: 'raw',
      lines: [canonicalLine()],
    });
    const stub = parseStub();

    await svc(stub).parseImport(IMPORT_ID);

    const line = insertedLines(stub)[0]!;
    expect(line.description).toBe('Nike Pegasus 41 - 10.5');
    for (const col of [
      'variant_size',
      'variant_size_original',
      'variant_size_system',
      'variant_width',
      'variant_fit',
      'variant_color',
      'jersey_number',
      'player_name',
      'group_hint',
      'suggested_group_id',
      'mapping_confidence',
    ]) {
      expect(line[col]).toBeNull();
    }
  });
});
