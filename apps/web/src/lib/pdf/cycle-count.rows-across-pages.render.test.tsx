// @vitest-environment node
import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { CycleCountSheetPdf, type CycleCountPdfLine } from './cycle-count';

/**
 * A sheet of short one-line rows that runs past its first page prints every
 * row. Before the rows were kept whole across a page break (#492), such a
 * sheet of 27 rows or more printed row 1 on page 1, placed rows 2 to 26 many
 * millions of points below the page, so they were on no page at all, and
 * carried on with row 27 on page 2. Seen with 27 to 70 rows, and 85, 100,
 * 150, 250 and 400, on the count sheet and on the variance report; a sheet
 * with a two-line row among its first 26 was not affected.
 *
 * These tests render the real component and read back the page and the
 * height each row number and SKU was printed at, through pdf-parse's bundled
 * pdf.js (as cycle-count.render.test.tsx does). All names below are made up.
 */

interface Printed {
  str: string;
  /** 1-based page the text is on. */
  page: number;
  x: number;
  /** Baseline, in PDF points from the page bottom. */
  y: number;
  /** The page's height in points. */
  pageHeight: number;
}

type PdfTextItem = { str: string; transform: number[] };
type PdfPage = {
  pageIndex: number;
  view: number[];
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
};
type PdfParse = (
  data: Uint8Array,
  options: { pagerender: (page: PdfPage) => Promise<string> },
) => Promise<{ numpages: number }>;

async function printedText(pdf: Buffer): Promise<{ pages: number; items: Printed[] }> {
  const { default: parse } = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: PdfParse;
  };
  const items: Printed[] = [];
  const parsed = await parse(new Uint8Array(pdf), {
    pagerender: async (page) => {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str.trim()) continue;
        items.push({
          str: item.str.trim(),
          page: page.pageIndex + 1,
          x: item.transform[4]!,
          y: item.transform[5]!,
          pageHeight: page.view[3]!,
        });
      }
      return '';
    },
  });
  return { pages: parsed.numpages, items };
}

const sku = (n: number) => `GS-${String(n).padStart(4, '0')}`;

function shortRows(count: number, counted: boolean): CycleCountPdfLine[] {
  return Array.from({ length: count }, (_, i) => ({
    sku: sku(i + 1),
    name: `Glue sticks pack ${i + 1}`,
    unitOfMeasure: 'each',
    location: `Rack ${(i % 9) + 1}-A`,
    // Not a number a row can be numbered, so "1".."41" below are row numbers.
    expectedQuantity: 1200,
    countedQuantity: counted ? 1200 : null,
  }));
}

async function render(count: number, status: 'in_progress' | 'completed') {
  const pdf = await renderToBuffer(
    <CycleCountSheetPdf
      cycle={{
        id: 'cc-1',
        countNumber: 7,
        warehouseId: 'w-1',
        scope: 'warehouse',
        warehouseName: 'North Annex',
        notes: null,
        startedAt: '2026-11-03T16:00:00Z',
        status,
      }}
      lines={shortRows(count, status === 'completed')}
      org={{ name: 'Brightwater Learning Co', logoUrl: null }}
    />,
  );
  return printedText(pdf);
}

/** Inside the page's own height, so it is on the paper. */
const onPaper = (i: Printed) => i.y > 0 && i.y < i.pageHeight;

describe('cycle count sheet: every row of a sheet of short rows prints, on a page', () => {
  for (const status of ['in_progress', 'completed'] as const) {
    for (const count of [30, 41]) {
      it(`prints all ${count} one-line rows inside a page, more than one of them on page 1 (${status})`, async () => {
        const { pages, items } = await render(count, status);
        expect(pages).toBe(2);
        // The # column is the leftmost text of a row: its x is row 1's.
        const numberX = Math.min(...items.filter((i) => i.str === '1').map((i) => i.x));
        const offPaper: string[] = [];
        const missing: string[] = [];
        const rowsOnPage1: number[] = [];
        for (let n = 1; n <= count; n += 1) {
          const number = items.filter((i) => i.str === String(n) && Math.abs(i.x - numberX) < 12);
          const code = items.filter((i) => i.str === sku(n));
          // Each row number and each SKU is printed exactly once.
          if (number.length !== 1) missing.push(`row number ${n} printed ${number.length} times`);
          if (code.length !== 1) missing.push(`${sku(n)} printed ${code.length} times`);
          for (const i of [...number, ...code]) {
            if (!onPaper(i)) offPaper.push(`"${i.str}" at y=${i.y.toFixed(0)} on page ${i.page}`);
          }
          const [num] = number;
          const [cod] = code;
          if (num && cod) {
            // The number sits on its own row: same page, same baseline area.
            expect(num.page, `row ${n}`).toBe(cod.page);
            expect(Math.abs(num.y - cod.y), `row ${n}`).toBeLessThan(4);
            if (num.page === 1 && onPaper(num)) rowsOnPage1.push(n);
          }
        }
        expect(missing).toEqual([]);
        expect(offPaper).toEqual([]);
        // Page 1 holds a run of rows from row 1 on, not row 1 alone, and the
        // rest follow on page 2.
        expect(rowsOnPage1.length).toBeGreaterThan(1);
        expect(rowsOnPage1).toEqual(rowsOnPage1.map((_, i) => i + 1));
        expect(rowsOnPage1.length).toBeLessThan(count);
      });
    }
  }
});
