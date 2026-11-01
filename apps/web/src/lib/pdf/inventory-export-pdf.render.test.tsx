// @vitest-environment node
import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';
import { width } from '@/test/pdf-font-metrics';

import {
  buildExportPdfRows,
  catalogValueWidthPt,
  InventoryExportPdf,
} from './inventory-export-pdf';

/**
 * These tests render the real PDF and read back where each line of text was
 * printed, through pdf-parse's bundled pdf.js. The element-tree suite
 * (inventory-export-pdf.test.tsx) shows what the document hands react-pdf;
 * this one shows what react-pdf then prints, which is where a long SKU or
 * title used to run past its card or over the cover.
 */

interface Printed {
  str: string;
  x: number;
  y: number;
  /** Where the last visible glyph ends. A line broken at a space keeps that
   *  space at its end, past the box; it prints nothing, so it is left out. */
  right: number;
}

type PdfTextItem = { str: string; transform: number[]; width: number };
type PdfPage = { getTextContent: () => Promise<{ items: PdfTextItem[] }> };
type PdfParse = (
  data: Uint8Array,
  options: { pagerender: (page: PdfPage) => Promise<string> },
) => Promise<unknown>;

async function printedText(pdf: Buffer): Promise<Printed[]> {
  // The lib path, not the package root: pdf-parse's index reads a sample PDF
  // when it loads (see src/types/pdf-parse-lib.d.ts).
  const { default: parse } = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: PdfParse;
  };
  const items: Printed[] = [];
  // A plain Uint8Array, not the Buffer itself: the bundled pdf.js 1.10
  // rejects some valid PDFs ("bad XRef entry") when it is handed a Node
  // Buffer, and reads the same bytes as a Uint8Array.
  await parse(new Uint8Array(pdf), {
    pagerender: async (page) => {
      const content = await page.getTextContent();
      for (const item of content.items) {
        const x = item.transform[4]!;
        const fontSizePt = item.transform[0]!;
        const trailing = ' '.repeat(item.str.length - item.str.trimEnd().length);
        const right = x + item.width - width(trailing, 'Helvetica', fontSizePt);
        items.push({ str: item.str, x, y: item.transform[5]!, right });
      }
      return '';
    },
  });
  return items;
}

function source(overrides: Partial<InventoryExportSourceRow>): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Algebra One',
    sku: 'BK-0001',
    barcode: '',
    status: 'active',
    quantityOnHand: 4,
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
    isbn: '9780262033848',
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    image: null,
    legacyRawBookFields: {
      grade: '',
      rackNumber: '',
      rackRow: '',
      crateColor: '',
      crateNumber: '',
    },
    ...overrides,
  };
}

async function renderExport(
  keys: InventoryExportFieldKey[],
  rows: InventoryExportSourceRow[],
  opts: { layout: 'table' | 'catalog'; columns?: 1 | 2 | 3 },
) {
  const fields = keys.map((k) => getExportField(k)!);
  const columns = opts.columns ?? 2;
  const layout = computeExportPdfLayout({
    fields,
    itemTypeKind: 'book',
    includeImages: false,
    imageSize: 'medium',
    orientation: 'auto',
    paperSize: 'letter',
    density: 'comfortable',
    wrapText: true,
    layout: opts.layout,
    catalogColumns: columns,
    rows,
  });
  const pdf = await renderToBuffer(
    InventoryExportPdf({
      orgName: 'Example Org',
      orgLogoUrl: null,
      title: 'Books export',
      subtitle: 'test',
      layout,
      rows: buildExportPdfRows(rows, layout, fields, { showImages: false }),
      repeatHeaders: false,
      pageNumbers: false,
      catalog: opts.layout === 'catalog' ? { columns, fields, itemTypeKind: 'book' } : null,
    }),
  );
  return { layout, printed: await printedText(pdf) };
}

/** Text printed at or below the first card or row whose first line is `str`. */
function belowHeader(printed: Printed[], str: string): Printed[] {
  const first = printed.find((p) => p.str === str);
  expect(first, `"${str}" was not printed`).toBeDefined();
  return printed.filter((p) => p.y <= first!.y + 0.5);
}

const LONG_SKU = 'MATH-GRADE5-WORKBOOK-2026-ED2-XL';
const DIGIT_SKU = '012345678901234567890123456789012345';
const LONG_TITLE = 'Introduction to Algorithms Third Edition Student Workbook Volume Two';
const LONG_AUTHOR = 'Thomas Example and Charles Example and Ronald Example and Clifford Example';

describe('InventoryExportPdf — what a catalog card prints', () => {
  /*
   * Where each card's text may print, worked out by hand from the page:
   * Letter portrait is 612pt wide with 40pt page padding, so two cards share
   * 532pt, 266pt each. Inside a card: 4pt gap, 0.5pt border, 6pt padding,
   * then the 66pt cover and a 6pt gap. Left card: 40 + 4 + 0.5 + 6 + 66 + 6
   * = 122.5 to 306 - 4 - 0.5 - 6 = 295.5. Right card: the same from 306.
   * Three cards go landscape (792pt, 712pt shared, 237.33pt each) with a
   * 50pt cover.
   */
  const CASES = [
    {
      columns: 2 as const,
      cards: [
        [122.5, 295.5],
        [388.5, 561.5],
      ],
    },
    {
      columns: 3 as const,
      cards: [
        [106.5, 266.83],
        [343.83, 504.17],
        [581.17, 741.5],
      ],
    },
  ];

  for (const { columns, cards } of CASES) {
    it(`keeps every line inside its own card and clear of the cover (${columns} across)`, async () => {
      const { printed } = await renderExport(
        ['name', 'author', 'isbn', 'sku', 'barcode'],
        [
          source({ id: 'i-1', name: 'Algebra One', sku: LONG_SKU }),
          source({ id: 'i-2', name: LONG_TITLE, author: LONG_AUTHOR }),
          source({ id: 'i-3', name: 'Geometry', barcode: DIGIT_SKU }),
        ].slice(0, columns),
        { layout: 'catalog', columns },
      );
      const inCards = belowHeader(printed, 'Algebra One');
      expect(inCards.length).toBeGreaterThan(columns * 4);
      for (const item of inCards) {
        const card = cards.find(([left, right]) => item.x >= left! - 20 && item.x <= right!);
        expect(
          card,
          `"${item.str}" printed at x=${item.x.toFixed(1)}, outside every card`,
        ).toBeDefined();
        const [left, right] = card!;
        expect(item.x, `"${item.str}" starts over the cover`).toBeGreaterThanOrEqual(left! - 0.25);
        expect(item.right, `"${item.str}" runs past its card`).toBeLessThanOrEqual(right! + 0.25);
      }
    });
  }

  it('prints a long SKU and barcode whole, every character once, on lines of their own', async () => {
    const { printed } = await renderExport(
      ['name', 'sku', 'barcode'],
      [source({ id: 'i-1', name: 'Algebra One', sku: LONG_SKU, barcode: DIGIT_SKU })],
      { layout: 'catalog', columns: 2 },
    );
    // The value column starts after the 54pt label: 122.5 + 54 = 176.5.
    const values = belowHeader(printed, 'Algebra One').filter((p) => Math.abs(p.x - 176.5) < 0.5);
    const lines = values.map((p) => p.str);
    expect(lines).toEqual([
      'MATH-GRADE5-',
      'WORKBOOK-2026-ED2-XL',
      '0123456789012345678901234',
      '56789012345',
    ]);
  });

  it('breaks identifiers to the width the card gives its value', () => {
    // 266pt card - 21pt of gap, border and padding - 66pt cover - 6pt gap -
    // 54pt label.
    expect(catalogValueWidthPt(612, 2)).toBe(119);
    expect(catalogValueWidthPt(612, 1)).toBe(367);
    expect(catalogValueWidthPt(792, 3)).toBeCloseTo(106.33, 2);
  });
});

describe('InventoryExportPdf — an identifier past the column cap in the table', () => {
  async function skuLines(sku: string) {
    const { layout, printed } = await renderExport(
      ['name', 'sku', 'quantity_on_hand'],
      [source({ sku })],
      { layout: 'table' },
    );
    // Pinned so the fixture really is past the 150pt identifier cap.
    expect(layout.columns.map((c) => [c.key, c.widthPt])).toEqual([
      ['name', 304],
      ['sku', 150],
      ['quantity_on_hand', 70],
    ]);
    // 40pt page padding + 4pt row padding + the 304pt name column + 3pt cell
    // padding; the text box ends 3pt before the column's right edge.
    const left = 40 + 4 + 304 + 3;
    const right = 40 + 4 + 304 + 150 - 3;
    // Below the header row: a two-line SKU starts above the row's centred name.
    const header = printed.find((p) => p.str === 'SKU');
    expect(header).toBeDefined();
    const lines = printed.filter((p) => p.y < header!.y - 1 && Math.abs(p.x - left) < 0.5);
    return { lines, right };
  }

  it('prints a hyphenated SKU exactly, with no hyphen added where a line ends', async () => {
    const sku = `${LONG_SKU}-EXTRA`;
    const { lines, right } = await skuLines(sku);
    expect(lines.map((l) => l.str)).toEqual(['MATH-GRADE5-WORKBOOK-2026-', 'ED2-XL-EXTRA']);
    expect(lines.map((l) => l.str).join('')).toBe(sku);
    for (const line of lines) expect(line.right).toBeLessThanOrEqual(right + 0.25);
  });

  it('prints a long run of digits whole inside its column rather than past the clip', async () => {
    const { lines, right } = await skuLines(DIGIT_SKU);
    expect(lines.map((l) => l.str).join('')).toBe(DIGIT_SKU);
    for (const line of lines) expect(line.right).toBeLessThanOrEqual(right + 0.25);
  });
});
