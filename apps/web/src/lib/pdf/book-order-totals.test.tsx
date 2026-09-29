import { renderToBuffer } from '@react-pdf/renderer';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import { bookReportPdfCoverNote, type BookReportRow } from '@stockpilot/core';

import {
  BOOK_PDF_CONTENT_WIDTH_PT,
  BOOK_PDF_HEADER_FONT_SIZE_PT,
  BOOK_PDF_METRIC_BORDER_PT,
  BOOK_PDF_METRIC_PADDING_PT,
  BOOK_PDF_METRIC_UNIT_FONT_SIZE_PT,
  BOOK_PDF_METRIC_VALUE_FONT_SIZE_PT,
  BOOK_PDF_HEADER_LETTER_SPACING_PT,
  BOOK_PDF_ROW_PADDING_PT,
  BOOK_PDF_TITLE_MAX_CHARS,
  BookOrderTotalsPdf,
  bookPdfColumns,
  pdfTitle,
  type BookOrderTotalsPdfProps,
} from './book-order-totals';
import { REPORT_CELL_PADDING_PT } from './column-fit';

/**
 * The Book Order Totals PDF. Structure is asserted on the element tree (as
 * inventory-export-pdf.test.tsx does): a header row that repeats on every
 * page, rows that never split, a "Page N of M" footer, the cover column only
 * with covers, the disclosures printed. One real render proves react-pdf
 * lays it out across pages with an embedded cover.
 */

function* walk(node: unknown): Generator<{ type: unknown; props: Record<string, unknown> }> {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== 'object') return;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return;
  yield { type: el.type, props: el.props };
  yield* walk(el.props.children);
}

const texts = (tree: unknown) =>
  [...walk(tree)]
    .filter((el) => el.type === 'TEXT')
    .map((el) => el.props.children)
    .filter((c): c is string => typeof c === 'string');

function row(i: number, extra: Partial<BookReportRow> = {}): BookReportRow {
  return {
    itemId: `i-${i}`,
    name: `Book ${i}`,
    sku: `BK-${i}`,
    identifier: '9780140449136',
    binLocation: 'R1-A',
    unit: 'unit',
    countsAsCopies: true,
    warehouseId: 'w',
    warehouseName: 'North',
    itemStatus: 'active',
    deleted: false,
    nowRental: false,
    copies: '30',
    orders: 3,
    lines: 3,
    latestOrderAt: null,
    latestOrderDate: '2026-03-31',
    fulfilled: '8',
    returned: '2',
    ...extra,
  };
}

function props(over: Partial<BookOrderTotalsPdfProps> = {}): BookOrderTotalsPdfProps {
  return {
    orgName: 'Demo Co',
    orgLogo: null,
    generatedAtLocal: '2026-09-28 10:42',
    timeZone: 'America/Los_Angeles',
    scopeLines: ['Orders placed during: All time', 'Status: Pending, In progress.'],
    summary: { copies: '34', entries: 2, orders: 3, unresolved: { entries: 0 } },
    summaryNotes: [],
    coverNote: 'Covers shown for 2 of 2 books.',
    photos: true,
    rows: [
      { row: row(1), cover: null },
      {
        row: row(2, {
          countsAsCopies: false,
          unit: 'pack of 10',
          copies: '12',
          itemStatus: 'archived',
        }),
        cover: null,
      },
    ],
    ...over,
  };
}

describe('BookOrderTotalsPdf structure', () => {
  it('repeats the table header on every page and never splits a row', () => {
    const tree = BookOrderTotalsPdf(props());
    const els = [...walk(tree)];
    const header = els.find((el) => el.type === 'VIEW' && el.props.fixed === true);
    expect(header).toBeDefined();
    const rows = els.filter((el) => el.props['data-row'] === true);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.props.wrap).toBe(false);
  });
  it('prints "Page N of M" in a fixed footer with the generation time', () => {
    const tree = BookOrderTotalsPdf(props());
    const footer = [...walk(tree)].find(
      (el) => el.type === 'TEXT' && typeof el.props.render === 'function',
    )!;
    expect(footer.props.fixed).toBe(true);
    const render = footer.props.render as (p: { pageNumber: number; totalPages: number }) => string;
    expect(render({ pageNumber: 1, totalPages: 4 })).toBe(
      'Book Order Totals · Generated Sep 28, 2026, 10:42 AM · Page 1 of 4',
    );
  });
  it('prints the summary, the grand total, the disclosures and a placeholder for a missing cover', () => {
    const note = bookReportPdfCoverNote({
      photos: true,
      rows: 612,
      shown: 498,
      failed: 2,
      pastCap: 112,
    });
    const tree = BookOrderTotalsPdf(
      props({ coverNote: note, summaryNotes: ['Not counted as copies: x.'] }),
    );
    const all = texts(tree);
    expect(all).toContain('Total books ordered');
    // The figure alone, its words on their own line (as the page's card).
    expect(all).toContain('34');
    expect(all).toContain('copies requested');
    expect(all).toContain(
      'Copies requested through Orders; not copies purchased or current stock.',
    );
    expect(all).toContain('Grand total: 34 copies requested in 3 orders · 2 book entries.');
    expect(all).toContain(note);
    expect(all).toContain('Not counted as copies: x.');
    expect(all).toContain('How this is counted');
    expect(all).toContain('pack of 10');
    expect(all.some((t) => t.includes('Archived'))).toBe(true);
    expect([...walk(tree)].filter((el) => el.props['data-placeholder'] === true)).toHaveLength(2);
  });
  it('names the quantity column "Copies requested" only when every row is in copies', () => {
    const header = (anyOtherUnit: boolean) =>
      bookPdfColumns(true, anyOtherUnit).find((c) => c.key === 'copies')!.label;
    expect(header(false)).toBe('Copies requested');
    expect(header(true)).toBe('Quantity requested');
    const all = texts(
      BookOrderTotalsPdf(
        props({ summary: { copies: '30', entries: 2, orders: 3, unresolved: { entries: 1 } } }),
      ),
    );
    expect(all).toContain('Quantity requested');
    expect(all).not.toContain('Copies requested');
  });
  it('with an other-unit row, the grand total never ties the copies to the order count', () => {
    // 15 copies from 3 orders, and a 4th order holding only a pack book.
    const all = texts(
      BookOrderTotalsPdf(
        props({ summary: { copies: '15', entries: 4, orders: 4, unresolved: { entries: 1 } } }),
      ),
    );
    expect(all).toContain(
      'Grand total: 15 copies requested. Orders containing books: 4. Distinct book entries: 4.',
    );
    expect(all.some((t) => /copies requested in \d/.test(t))).toBe(false);
  });
  it('without covers the cover column is dropped and the Book column takes its width', () => {
    const tree = BookOrderTotalsPdf(
      props({ photos: false, coverNote: 'Exported without covers.' }),
    );
    expect([...walk(tree)].filter((el) => el.props['data-placeholder'] === true)).toHaveLength(0);
    const withCovers = bookPdfColumns(true);
    const without = bookPdfColumns(false);
    expect(without.map((c) => c.key)).toEqual(['book', 'copies', 'orders', 'latest']);
    expect(without[0]!.widthPt).toBe(withCovers[1]!.widthPt + withCovers[0]!.widthPt);
    expect(texts(tree)).toContain('Exported without covers.');
  });
  it('every column adds up to the content width', () => {
    for (const photos of [true, false]) {
      const total =
        bookPdfColumns(photos).reduce((s, c) => s + c.widthPt, 0) + BOOK_PDF_ROW_PADDING_PT * 2;
      expect(total).toBe(BOOK_PDF_CONTENT_WIDTH_PT);
    }
  });
  it('cuts a very long title with an ellipsis', () => {
    expect(pdfTitle('x'.repeat(400))).toHaveLength(BOOK_PDF_TITLE_MAX_CHARS);
    expect(pdfTitle('Short')).toBe('Short');
  });
});

describe('Book Order Totals PDF headers fit', () => {
  // The header renders uppercase with letter spacing, and react-pdf applies
  // textTransform before measuring, so the box must fit the UPPERCASE label.
  const headerWidth = (label: string) => {
    const shown = label.toUpperCase();
    return (
      width(shown, 'Helvetica-Bold', BOOK_PDF_HEADER_FONT_SIZE_PT) +
      shown.length * BOOK_PDF_HEADER_LETTER_SPACING_PT
    );
  };
  for (const [photos, otherUnits] of [
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ] as const) {
    it(`every header fits its content box (${photos ? 'with' : 'without'} covers${otherUnits ? ', other units' : ''})`, () => {
      for (const col of bookPdfColumns(photos, otherUnits)) {
        const box = col.widthPt - REPORT_CELL_PADDING_PT * 2;
        expect(
          headerWidth(col.label) <= box,
          `"${col.label}" needs ${headerWidth(col.label).toFixed(1)}pt of ${box}pt`,
        ).toBe(true);
      }
    });
  }
});

describe('Book Order Totals PDF summary box', () => {
  // Three equal metrics inside one hairline box. A figure that does not fit
  // its box on one line wraps, and react-pdf hyphenates the words: an
  // 18,790 total printed as "18,790 copies request-" / "ed" (seen in the
  // local e2e export, 2026-09-28). The figure is therefore printed alone and
  // must fit for any total the report can reach.
  const box =
    (BOOK_PDF_CONTENT_WIDTH_PT - BOOK_PDF_METRIC_BORDER_PT * 4) / 3 -
    BOOK_PDF_METRIC_PADDING_PT * 2;
  it('a nine-digit total with decimals fits its box on one line', () => {
    const shown = '123,456,789.1234';
    expect(
      width(shown, 'Helvetica-Bold', BOOK_PDF_METRIC_VALUE_FONT_SIZE_PT),
      `"${shown}" needs more than ${box.toFixed(1)}pt`,
    ).toBeLessThanOrEqual(box);
    expect(
      width('copies requested', 'Helvetica', BOOK_PDF_METRIC_UNIT_FONT_SIZE_PT),
    ).toBeLessThanOrEqual(box);
  });
  it('prints the figure and its words as separate lines, never one long value', () => {
    const tree = BookOrderTotalsPdf(
      props({
        summary: { copies: '18790', entries: 1151, orders: 1500, unresolved: { entries: 0 } },
      }),
    );
    const all = texts(tree);
    expect(all).toContain('18,790');
    expect(all).toContain('copies requested');
    expect(all).not.toContain('18,790 copies requested');
    expect(all).toContain('1,151');
    expect(all).toContain('1,500');
    expect(all).toContain(
      'Grand total: 18,790 copies requested in 1,500 orders · 1,151 book entries.',
    );
  });
  it('one copy reads "copy requested"', () => {
    expect(
      texts(BookOrderTotalsPdf(props({ summary: { copies: '1', entries: 1, orders: 1, unresolved: { entries: 0 } } }))),
    ).toContain('copy requested');
  });
});

describe('Book Order Totals PDF render', () => {
  it('lays out 120 rows across several pages with a real embedded cover', async () => {
    const jpeg = await sharp({
      create: { width: 36, height: 54, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const cover = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const rows = Array.from({ length: 120 }, (_, i) => ({
      row: row(i + 1),
      cover: i === 0 ? cover : null,
    }));
    const buf = await renderToBuffer(
      BookOrderTotalsPdf(props({ rows, summary: { copies: '3600', entries: 120, orders: 360, unresolved: { entries: 0 } } })),
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = buf.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThan(5);
  });
});
