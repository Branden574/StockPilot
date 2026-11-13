// @vitest-environment node
import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import { CycleCountSheetPdf, type CycleCountPdfLine } from './cycle-count';

/**
 * These tests render the real count sheet and read back where each line of
 * text was printed, through pdf-parse's bundled pdf.js (as
 * inventory-export-pdf.render.test.tsx does). The owner's report: on a printed
 * count sheet a long item title ran into the text beside it. Two causes, both
 * seen here: a wrapped title filled each line up to the exact x where the
 * Location text starts ("...five Bright-door"), and a word with no break point
 * (a model code, "Grade3/Grade4/...") was printed straight over the Location
 * column. All names below are made up.
 */

interface Printed {
  str: string;
  x: number;
  /** Baseline, in PDF points from the page bottom. */
  y: number;
  /** Where the last visible glyph ends (a trailing space prints nothing). */
  right: number;
}

type PdfTextItem = { str: string; transform: number[]; width: number };
type PdfPage = { getTextContent: () => Promise<{ items: PdfTextItem[] }> };
type PdfParse = (
  data: Uint8Array,
  options: { pagerender: (page: PdfPage) => Promise<string> },
) => Promise<unknown>;

async function printedText(pdf: Buffer): Promise<Printed[]> {
  const { default: parse } = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: PdfParse;
  };
  const items: Printed[] = [];
  await parse(new Uint8Array(pdf), {
    pagerender: async (page) => {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str.trim()) continue;
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

const UNBROKEN = 'QX9000QX9100QX9200QX9300QX9400QX9500QX9600QX9700';
const SLASHED = 'Grade3/Grade4/Grade5/Grade6/Grade7/Grade8';
const LONG_TITLE =
  'Brightwater classroom science kit with twelve sample jars magnifier set laminated activity ' +
  'cards teacher guide spare lids storage tote and fold out lab mat for grades three through five';

function line(p: Partial<CycleCountPdfLine> & { sku: string; name: string }): CycleCountPdfLine {
  return { unitOfMeasure: 'each', location: 'Rack 3-A', expectedQuantity: 12, ...p };
}

async function render(lines: CycleCountPdfLine[], status = 'in_progress') {
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
      lines={lines}
      org={{ name: 'Brightwater Learning Co', logoUrl: null }}
    />,
  );
  return printedText(pdf);
}

/** The x each column's text starts at, read off the printed sheet. */
function columns(items: Printed[]) {
  const at = (s: string) => {
    const hit = items.find((i) => i.str.trim() === s);
    if (!hit) throw new Error(`"${s}" was not printed`);
    return hit;
  };
  return {
    /** The table header's baseline: every row prints below it. */
    headerY: at('SKU').y,
    sku: at('AA-0001').x,
    description: at('Glue sticks').x,
    location: at('Rack 3-A').x,
    /** The centred System quantity, the first text right of Location. */
    system: at('12').x,
  };
}

/** White space a column's text must leave before the next column's text. */
const MIN_GAP_PT = 3;

describe('cycle count sheet: a long item title never runs into the next column', () => {
  for (const status of ['in_progress', 'completed']) {
    it(`keeps every column's text short of the next column (${status})`, async () => {
      const items = await render(
        [
          line({ sku: 'AA-0001', name: 'Glue sticks' }),
          line({ sku: 'AA-0002', name: LONG_TITLE }),
          line({ sku: 'AA-0003', name: `Cable ${UNBROKEN} spare` }),
          line({ sku: 'AA-0004', name: `${SLASHED} reader bundle set` }),
          line({ sku: 'LAPTOPQX3100REFURBGRADEA2026', name: 'Laptop, refurbished' }),
        ].map((l, i) => ({ ...l, countedQuantity: status === 'completed' ? i : null })),
        status,
      );
      const col = columns(items);
      // Table rows only: below the header row, above the footer (the page's
      // bottom padding is 56pt), and not the sign-off captions under the table.
      const rows = items.filter(
        (i) =>
          i.y < col.headerY - 1 &&
          i.y > 56 &&
          !/^(Counted by|Date|Approved by)$/.test(i.str.trim()),
      );
      const offenders: string[] = [];
      for (const [name, from, to] of [
        ['SKU', col.sku, col.description],
        ['Description', col.description, col.location],
        ['Location', col.location, col.system],
      ] as const) {
        const cells = rows.filter((i) => i.x >= from - 0.5 && i.x < to - 0.5);
        expect(cells.length).toBeGreaterThan(0);
        for (const cell of cells) {
          if (cell.right > to - MIN_GAP_PT) {
            offenders.push(
              `${name} "${cell.str.trim()}" ends at ${cell.right.toFixed(1)}, next column starts at ${to.toFixed(1)}`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('prints every character of an over-wide word, on lines that fit', async () => {
    const items = await render([
      line({ sku: 'AA-0001', name: 'Glue sticks' }),
      line({ sku: 'AA-0003', name: `Cable ${UNBROKEN} spare` }),
      line({ sku: 'AA-0004', name: `${SLASHED} reader bundle set` }),
    ]);
    const col = columns(items);
    const description = items
      .filter((i) => i.x >= col.description - 0.5 && i.x < col.location - 0.5)
      .map((i) => i.str)
      .join('')
      .replace(/\s+/g, '');
    expect(description).toContain(UNBROKEN);
    expect(description).toContain(SLASHED);
    // The slashed run breaks after one of its own slashes.
    expect(items.some((i) => /^Grade3\/.*\/$/.test(i.str.trim()))).toBe(true);
  });

  it('does not move any column on a sheet of short titles', async () => {
    // The x each column has always started at (origin/main before this fix):
    // a LETTER row 524pt wide from x=44, split 5/18/31/14/9/11/12 after the
    // count sheet's 8pt of write-in-line margins.
    const sheet = columns(await render([line({ sku: 'AA-0001', name: 'Glue sticks' })]));
    expect(sheet.sku).toBeCloseTo(69.8, 1);
    expect(sheet.description).toBeCloseTo(162.68, 1);
    expect(sheet.location).toBeCloseTo(322.64, 1);
    const report = columns(
      await render(
        [line({ sku: 'AA-0001', name: 'Glue sticks', countedQuantity: 12 })],
        'completed',
      ),
    );
    expect(report.sku).toBeCloseTo(70.2, 1);
    expect(report.description).toBeCloseTo(164.52, 1);
    expect(report.location).toBeCloseTo(326.96, 1);
  });
});
