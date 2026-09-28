/**
 * WORDING GUARD for Book Order Totals. Every line the report can show is
 * rendered here and searched:
 *   - the recorded-quantity jargon never appears ("the book", "book
 *     quantity", "on the books"; owner rule 2026-09-27: L4L stocks real
 *     books, so "book" means a book);
 *   - rows are never "unique titles", fulfilment is never "delivered", the
 *     generation time is never a "snapshot", and nothing is a percentage;
 *   - every metric carries its one-line definition;
 *   - "How this is counted" carries the plan's limitation sentences.
 */
import { describe, expect, it } from 'vitest';

import { ORDER_STATUS_KEYS } from '../customization/order-status';

import {
  BOOK_REPORT_STATUS_GROUP_KEYS,
  bookReportStatusLabels,
  type BookReportStatusGroup,
} from './book-order-totals';
import * as copy from './book-order-totals-copy';

const labels = bookReportStatusLabels(null);
// Status names are the organization's own labels (the core default for
// completed is "Delivered", a status NAME the Orders page shows). The guard
// judges this report's own words, so it renders status lines with neutral
// labels; the status-line test below shows the default labels pass through.
const guardLabels = bookReportStatusLabels({ completed: { label: 'Completed' } });

function rendered(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value.map(String));
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) {
        if (typeof v === 'string') out.push(v);
        else if (v && typeof v === 'object') out.push(...Object.values(v).map(String));
      }
    } else if (typeof value !== 'function') {
      throw new Error(`unexpected export ${key}`);
    }
  }
  const groupSets: BookReportStatusGroup[][] = [
    ['awaiting', 'in_progress', 'backordered', 'completed'],
    [...BOOK_REPORT_STATUS_GROUP_KEYS],
    ['completed', 'denied'],
    ['cancelled'],
  ];
  for (const g of groupSets) out.push(copy.bookReportStatusLine(g, guardLabels));
  out.push(
    copy.copiesRequestedText('642'),
    copy.copiesRequestedText('1'),
    copy.ordersCountText(26),
    copy.entriesCountText(32),
    copy.rowQuantityText({ copies: '12', countsAsCopies: false, unit: 'pack of 10' }),
    copy.unresolvedUnitsNote({ entries: 1, quantity: '12' }, 'pack of 10') ?? '',
    copy.unresolvedUnitsNote({ entries: 3, quantity: '40' }) ?? '',
    copy.bookReportRangeLine(
      { key: 'all', from: null, to: null },
      { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' },
    ),
    copy.bookReportRangeLine({ key: '30d', from: '2026-08-30', to: '2026-09-28' }),
    copy.bookReportRangeLine({ key: 'custom', from: '2026-09-01', to: '2026-09-28' }),
    copy.bookReportZoneLine({ timeZone: 'America/Los_Angeles', timeZoneFallback: true }),
    copy.bookReportInProgressDetail(guardLabels),
    copy.bookReportWarehouseLine({ id: 'w', name: 'DC4', status: 'active' }, 'view'),
    copy.bookReportWarehouseLine({ id: 'w', name: 'North', status: 'archived' }, 'explicit'),
    copy.bookReportWarehouseLine(null, 'all'),
    copy.bookReportCategoryLine({ id: 'c', name: 'Fiction', deleted: true }, false) ?? '',
    copy.bookReportCategoryLine(null, true) ?? '',
    copy.bookReportSearchLine('hobbit') ?? '',
    copy.bookReportGeneratedLine('2026-09-28 10:42'),
    copy.bookReportGrandTotalLine({ copies: '642', orders: 26 }, 2),
    copy.latestOrderText('2026-09-20'),
    ...copy.bookReportRowBadges({
      itemStatus: 'archived',
      deleted: false,
      nowRental: true,
      countsAsCopies: false,
      unit: 'pack of 10',
    }),
    copy.bookCoverAlt('Book A'),
    copy.bookReportDrawerHeader({ countsAsCopies: true, unit: 'ea' }, { copies: '30', orders: 3 }),
    copy.bookReportDrawerHeader(
      { countsAsCopies: false, unit: 'pack of 10' },
      { copies: '12', orders: 2 },
    ),
    copy.combinedLinesText(2) ?? '',
    copy.fulfilledReturnedLine({ fulfilled: '8', returned: '2' }) ?? '',
    copy.bookReportAsOfNote('2026-09-28 10:42'),
    copy.bookReportTooManyText(21340, 20000),
    copy.bookReportPdfCoverNote({ photos: true, rows: 612, shown: 498, failed: 2, pastCap: 112 }),
    copy.bookReportPdfCoverNote({ photos: false, rows: 612, shown: 0, failed: 0, pastCap: 0 }),
    copy.bookReportOfflineAsOf('2026-09-28 10:42'),
  );
  return out;
}

describe('Book Order Totals wording', () => {
  const lines = rendered();

  it('renders a real set of lines', () => {
    expect(lines.length).toBeGreaterThan(80);
  });

  it.each([
    ['"the book"', /\bthe book\b/i],
    ['"book quantity"', /\bbook (?:qty|quantity|quantities)\b/i],
    ['"on the books"', /\bon the books\b/i],
    ['"unique titles"', /\bunique titles?\b/i],
    ['"delivered"', /\bdelivered\b/i],
    ['"snapshot"', /\bsnapshot\b/i],
    ['a percentage', /%/],
  ])('never says %s', (_name, re) => {
    expect(lines.filter((l) => re.test(l))).toEqual([]);
  });

  it('every metric has its label and definition', () => {
    for (const m of Object.values(copy.BOOK_REPORT_METRICS)) {
      expect(m.label.length).toBeGreaterThan(5);
      expect(m.definition.endsWith('.')).toBe(true);
    }
    expect(copy.BOOK_REPORT_METRICS.copies).toEqual({
      label: 'Total books ordered',
      definition: 'Copies requested through Orders; not copies purchased or current stock.',
    });
    expect(copy.BOOK_REPORT_METRICS.entries.label).toBe('Distinct book entries');
  });

  it('"How this is counted" carries the limitation sentences', () => {
    const text = copy.BOOK_REPORT_HOW_COUNTED.join(' ');
    for (const sentence of [
      'Order dates and warehouses can be edited after an order is placed; the report uses the saved values.',
      "A backorder closed by lowering its quantity shows the lowered quantity; the original is in the order's history.",
      'Bundle distributions and rentals are not Orders and are not counted.',
      "The warehouse filter uses each order's warehouse.",
      'Books turned into rental items keep their order history.',
      "Status is each order's status now",
      'Present-day kit recipes are never expanded.',
      copy.BOOK_REPORT_FULFILLED_NOTE,
    ]) {
      expect(text).toContain(sentence);
    }
  });

  it('the status line says what is left out and, when chosen, what denied and cancelled mean', () => {
    expect(
      copy.bookReportStatusLine(['awaiting', 'in_progress', 'backordered', 'completed'], labels),
    ).toBe(
      'Status: Pending, In progress, Backordered, Delivered. Denied, cancelled and unconfirmed requests are left out.',
    );
    expect(
      copy.bookReportStatusLine(
        [...BOOK_REPORT_STATUS_GROUP_KEYS],
        bookReportStatusLabels({ completed: { label: 'Handed over' } }),
      ),
    ).toBe(
      'Status: Pending, In progress, Backordered, Handed over, Denied, Cancelled. Unconfirmed requests are left out. Includes denied and cancelled requests. Their quantities were asked for, not accepted or fulfilled.',
    );
  });

  it('the grand total and drawer header read as in the plan', () => {
    expect(copy.bookReportGrandTotalLine({ copies: '642', orders: 26 }, 2)).toBe(
      'Grand total for all 2 pages: 642 copies requested in 26 orders.',
    );
    expect(
      copy.bookReportDrawerHeader(
        { countsAsCopies: true, unit: 'unit' },
        { copies: '30', orders: 3 },
      ),
    ).toBe('Copies of this book requested: 30 in 3 orders');
    expect(
      copy.bookReportPdfCoverNote({ photos: true, rows: 612, shown: 498, failed: 2, pastCap: 112 }),
    ).toBe(
      'Covers shown for 498 of 612 books. 2 could not be loaded and 112 are past the 500-cover limit; each shows a placeholder. Every row and total is included.',
    );
    expect(
      copy.bookReportRangeLine(
        { key: 'all', from: null, to: null },
        { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' },
      ),
    ).toBe('Orders placed during: All time (May 12, 2026 – Sep 25, 2026)');
    expect(copy.bookReportRangeLine({ key: '30d', from: '2026-08-30', to: '2026-09-28' })).toBe(
      'Orders placed during: Last 30 days (Aug 30 – Sep 28, 2026)',
    );
  });

  it("labels every status group from the organization's own labels", () => {
    for (const g of BOOK_REPORT_STATUS_GROUP_KEYS) {
      expect(copy.bookReportStatusGroupLabel(g, labels).length).toBeGreaterThan(0);
    }
    expect(Object.keys(labels).sort()).toEqual([...ORDER_STATUS_KEYS].sort());
  });
});
