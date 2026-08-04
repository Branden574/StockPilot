import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from './exports/field-registry';
import type { InventoryExportSourceRow } from './exports/source-row';
import { readImageDimensions, toInventoryXlsx, XLSX_IMAGE_CELL } from './inventory-export-xlsx';

const fieldsFor = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

const BOOK_FIELDS: InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'author',
  'quantity_on_hand',
  'category',
  'status',
];

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42.5,
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
    // Legacy-only (see source-row.ts) — this module never reads it, but the
    // row shape requires it. DEVIATION from the brief's verbatim test (task-11
    // report): the brief's makeRow() omitted this required field, which fails
    // typecheck against InventoryExportSourceRow (legacyRawBookFields is
    // non-optional). Same convention already used by field-registry.test.ts,
    // export-images.test.ts and inventory-export-pdf.test.tsx.
    legacyRawBookFields: {
      grade: 'College',
      rackNumber: '38',
      rackRow: 'A',
      crateColor: 'blue',
      crateNumber: '12',
    },
    ...overrides,
  };
}

async function build(overrides: Partial<Parameters<typeof toInventoryXlsx>[0]> = {}) {
  const buffer = await toInventoryXlsx({
    fields: fieldsFor(BOOK_FIELDS),
    rows: [makeRow()],
    itemTypeKind: 'book',
    freezeHeader: true,
    autoFilter: true,
    includeSummarySheet: false,
    imageMode: null,
    imageSize: 'medium',
    ...overrides,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** A 1x1 PNG — real bytes, so exceljs and the dimension reader both accept it. */
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('toInventoryXlsx — sheet and headers', () => {
  it('names the worksheet Books for a books export and Inventory otherwise', async () => {
    expect((await build()).worksheets[0]!.name).toBe('Books');
    expect(
      (await build({ itemTypeKind: 'other', fields: fieldsFor(['name', 'sku']) })).worksheets[0]!
        .name,
    ).toBe('Inventory');
  });

  it('writes ONLY the selected fields, as friendly labels, in the chosen order', async () => {
    const wb = await build({ fields: fieldsFor(['status', 'isbn', 'name']) });
    const header = wb.worksheets[0]!.getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual(['Status', 'ISBN', 'Title']);
  });

  it('labels the image column Cover for books, not the raw key', async () => {
    const wb = await build({ imageMode: 'url' });
    const header = wb.worksheets[0]!.getRow(1).values as unknown[];
    expect(header[1]).toBe('Cover');
  });

  it('bolds and freezes the header when asked, and does not when not', async () => {
    const frozen = (await build()).worksheets[0]!;
    expect(frozen.getRow(1).font?.bold).toBe(true);
    expect(frozen.views?.[0]?.state).toBe('frozen');
    const loose = (await build({ freezeHeader: false })).worksheets[0]!;
    expect(loose.views?.[0]?.state ?? 'normal').not.toBe('frozen');
  });

  it('applies an autofilter over the whole used range when asked', async () => {
    const ws = (await build()).worksheets[0]!;
    expect(ws.autoFilter).toBeTruthy();
    const filtered = (await build({ autoFilter: false })).worksheets[0]!;
    expect(filtered.autoFilter).toBeFalsy();
  });

  it('gives long text columns more width than narrow numeric ones', async () => {
    const ws = (await build()).worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const widthOf = (label: string) => ws.getColumn(header.indexOf(label) + 1).width ?? 0;
    expect(widthOf('Title')).toBeGreaterThan(widthOf('On hand'));
  });
});

describe('toInventoryXlsx — cell types', () => {
  it('writes ISBN as TEXT with an explicit @ format, so no scientific notation', async () => {
    const wb = await build({ rows: [makeRow({ isbn: '0262033844' })] });
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const cell = ws.getRow(2).getCell(header.indexOf('ISBN') + 1);
    expect(cell.value).toBe('0262033844');
    expect(typeof cell.value).toBe('string');
    expect(cell.numFmt).toBe('@');
  });

  it('writes SKU and barcode as text too', async () => {
    const wb = await build({ fields: fieldsFor(['sku', 'barcode']), rows: [makeRow()] });
    const ws = wb.worksheets[0]!;
    for (const col of [1, 2]) {
      expect(ws.getRow(2).getCell(col).numFmt).toBe('@');
    }
  });

  it('writes quantities as real numbers, right aligned', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'quantity_on_hand']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBe(4);
    expect(typeof cell.value).toBe('number');
    expect(cell.alignment?.horizontal).toBe('right');
  });

  it('formats currency fields as currency', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'unit_cost']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBe(42.5);
    expect(cell.numFmt).toContain('0.00');
  });

  it('formats date fields as dates rather than raw ISO strings', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'created_at']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toContain('yyyy');
  });

  it('wraps long text columns', async () => {
    const wb = await build({ fields: fieldsFor(['name']) });
    expect(wb.worksheets[0]!.getRow(2).getCell(1).alignment?.wrapText).toBe(true);
  });

  it('defuses formula injection on every string cell', async () => {
    const wb = await build({
      fields: fieldsFor(['name', 'sku']),
      rows: [makeRow({ name: '=cmd|calc', sku: '@SUM(A1:A9)' })],
    });
    const row = wb.worksheets[0]!.getRow(2);
    expect(String(row.getCell(1).value).startsWith("'=")).toBe(true);
    expect(String(row.getCell(2).value).startsWith("'@")).toBe(true);
  });

  it('writes an empty cell, never the word undefined, for a missing value', async () => {
    const wb = await build({
      fields: fieldsFor(['name', 'author', 'isbn']),
      rows: [makeRow({ author: '', isbn: '' })],
    });
    const row = wb.worksheets[0]!.getRow(2);
    for (const col of [2, 3]) {
      const v = row.getCell(col).value;
      expect(v === null || v === '').toBe(true);
    }
  });
});

describe('toInventoryXlsx — images', () => {
  it('writes the URL as text in url mode', async () => {
    const wb = await build({
      imageMode: 'url',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.jpg' } })],
    });
    expect(wb.worksheets[0]!.getRow(2).getCell(1).value).toBe('https://signed.example/a.jpg');
  });

  it('embeds a picture and grows the row in embedded mode', async () => {
    const wb = await build({
      imageMode: 'embedded',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.png' } })],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.getRow(2).height).toBe(XLSX_IMAGE_CELL.medium.rowHeightPt);
    // The picture cell itself carries no URL text in embedded mode.
    expect(ws.getRow(2).getCell(1).value ?? '').toBe('');
  });

  it('writes BOTH a picture and the URL in both mode', async () => {
    const wb = await build({
      imageMode: 'both',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.png' } })],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    expect(header).toContain('Image URL');
    expect(ws.getRow(2).getCell(header.indexOf('Image URL') + 1).value).toBe(
      'https://signed.example/a.png',
    );
  });

  it('leaves the cell blank and keeps going when one image failed to fetch', async () => {
    const wb = await build({
      imageMode: 'embedded',
      rows: [
        makeRow({ id: 'i-1', image: { thumbnailUrl: 'https://signed.example/a.png' } }),
        makeRow({ id: 'i-2', image: null }),
      ],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.rowCount).toBe(3);
  });

  it('does no image work at all when the image field was not selected', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'sku']), imageMode: null });
    expect(wb.worksheets[0]!.getImages()).toHaveLength(0);
    const header = (wb.worksheets[0]!.getRow(1).values as unknown[]).slice(1) as string[];
    expect(header).not.toContain('Cover');
  });

  it('pins embedded image anchors to the correct cell: col=picture index, row=data row', async () => {
    // Regression hardening: ensure that image anchors are tied to the actual row/column,
    // not hardcoded to (0,0). Field order places image at index 1 (after name), so pictureIndex=1.
    const wb = await build({
      fields: fieldsFor(['name', 'image', 'isbn', 'sku']),
      imageMode: 'embedded',
      rows: [
        makeRow({
          id: 'item-row1',
          name: 'First Title',
          image: { thumbnailUrl: 'https://signed.example/first.png' },
        }),
        makeRow({
          id: 'item-row2',
          name: 'Second Title',
          image: { thumbnailUrl: 'https://signed.example/second.png' },
        }),
      ],
      images: new Map([
        ['item-row1', { data: PNG_1x1, extension: 'png' as const }],
        ['item-row2', { data: PNG_1x1, extension: 'png' as const }],
      ]),
    });
    const ws = wb.worksheets[0]!;
    const images = ws.getImages();
    expect(images).toHaveLength(2);

    // Field order: name at 0, image at 1, so pictureIndex = 1.
    // Row numbering: header is row 0, first data row is row 1, second data row is row 2.
    const expectedAnchors = [
      { col: 1, row: 1 }, // First data row (row 2 in Excel, row=1 in anchor)
      { col: 1, row: 2 }, // Second data row (row 3 in Excel, row=2 in anchor)
    ];

    images.forEach((img, idx) => {
      const expected = expectedAnchors[idx]!;
      // ExcelJS may return fractional parts; floor them for comparison.
      const actualCol = Math.floor(img.range.tl.col ?? 0);
      const actualRow = Math.floor(img.range.tl.row ?? 0);
      expect(actualCol).toBe(expected.col);
      expect(actualRow).toBe(expected.row);
    });
  });
});

describe('readImageDimensions', () => {
  it('reads a PNG header', () => {
    expect(readImageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for bytes it cannot parse instead of guessing', () => {
    expect(readImageDimensions(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });
});

describe('toInventoryXlsx — summary sheet', () => {
  it('adds no second sheet unless asked', async () => {
    expect((await build()).worksheets).toHaveLength(1);
  });

  it('counts titles, units, ISBN coverage and cover coverage for books', async () => {
    const wb = await build({
      includeSummarySheet: true,
      rows: [
        makeRow({ id: 'a', isbn: '1', image: { thumbnailUrl: 'u' }, quantityOnHand: 4 }),
        makeRow({ id: 'b', isbn: '', image: null, quantityOnHand: 6, category: 'History' }),
      ],
    });
    expect(wb.worksheets).toHaveLength(2);
    const summary = wb.worksheets[1]!;
    expect(summary.name).toBe('Summary');
    const text = JSON.stringify(summary.getSheetValues());
    expect(text).toContain('Total titles');
    expect(text).toContain('On-hand units');
    expect(text).toContain('With ISBN');
    expect(text).toContain('Missing ISBN');
    expect(text).toContain('With cover');
    expect(text).toContain('Missing cover');
    expect(text).toContain('Mathematics');
    expect(text).toContain('History');
  });

  it('omits inventory value from the summary when no financial field was exported', async () => {
    const wb = await build({
      itemTypeKind: 'other',
      fields: fieldsFor(['name', 'sku', 'quantity_on_hand']),
      includeSummarySheet: true,
    });
    const text = JSON.stringify(wb.worksheets[1]!.getSheetValues());
    expect(text).not.toContain('Inventory value');
  });

  it('includes inventory value when a financial field WAS exported', async () => {
    const wb = await build({
      itemTypeKind: 'other',
      fields: fieldsFor(['name', 'unit_cost']),
      includeSummarySheet: true,
    });
    expect(JSON.stringify(wb.worksheets[1]!.getSheetValues())).toContain('Inventory value');
  });
});

// ADDITION (not from the brief): XLSX_IMAGE_CELL is a cross-task contract —
// Task 8's PDF layout ships its own independently-derived per-size cell specs
// (IMAGE_CELL_PT in pdf-layout.ts), and this module's rowHeightPt/
// columnWidthChars/boxPx values are the Excel-side counterpart a human chose
// deliberately, not a value this module is free to renumber. Every assertion
// above that touches XLSX_IMAGE_CELL (e.g. "grows the row in embedded mode")
// compares the RENDERED workbook against the SAME live constant it's testing
// against, so it is a tautology: swapping two tiers' values entirely (e.g.
// medium's rowHeightPt with large's) passes every one of those tests, because
// both sides of the assertion read the mutated constant. Pinning against
// literal numbers here is the only thing that would catch that swap — this
// was proven by mutation during self-review (see Task 11 report).
describe('XLSX_IMAGE_CELL — literal pin', () => {
  it('locks each size tier to its exact literal numbers', () => {
    expect(XLSX_IMAGE_CELL).toEqual({
      small: { rowHeightPt: 42, columnWidthChars: 7, boxPx: { width: 40, height: 54 } },
      medium: { rowHeightPt: 66, columnWidthChars: 11, boxPx: { width: 64, height: 86 } },
      large: { rowHeightPt: 96, columnWidthChars: 15, boxPx: { width: 92, height: 124 } },
    });
  });
});
