// Security invariant: the Book Order Totals CSV. Every data cell passes the
// formula-injection guard and RFC 4180 quoting (a bare carriage return now
// quotes too); every metadata line above the table is sanitized (control
// characters, DEL and U+2028/9 become spaces, values capped at 200) and
// emitted as ONE quoted cell, so a warehouse name, a category or a search can
// never start a new row or cell. Parsed back with the repo's own spreadsheet
// parsers (exceljs csv.read, papaparse with dynamicTyping), no cell anywhere
// begins with = + - or @, and the text-safe identifier columns survive as
// text. The file carries no URL of any kind and exact quantity text. The
// ORDER charter's name (0382, free text) is neutralized the same way in the
// Charter line and in the constant charter_scope column.
import { Readable } from 'node:stream';

import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';

import { csvCell, csvMetaLine, sanitizeCsvText, toCsv } from '@/lib/csv';

import {
  BOOK_REPORT_RESTRICTED,
  bookReportStatusLabels,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  type BookOrderTotalsResponse,
  type BookReportRow,
} from '@stockpilot/core';

import {
  BOOK_REPORT_CSV_CHUNK_ROWS,
  BOOK_REPORT_CSV_COLUMNS,
  bookReportCsvChunks,
  bookReportExportDateRange,
  bookReportScopeLines,
  type BookReportExportInput,
} from './export-content';

const W1 = '0e000000-0000-4000-8000-0000000000d1';

function row(i: number, extra: Partial<BookReportRow> = {}): BookReportRow {
  return {
    itemId: `0e000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Book ${i}`,
    sku: `BK-${i}`,
    identifier: null,
    binLocation: 'R1-A',
    unit: 'unit',
    countsAsCopies: true,
    warehouseId: W1,
    warehouseName: 'North',
    itemStatus: 'active',
    deleted: false,
    nowRental: false,
    copies: '1',
    orders: 1,
    lines: 1,
    latestOrderAt: '2026-03-01T07:30:00+00:00',
    latestOrderDate: '2026-02-28',
    fulfilled: '0',
    returned: '0',
    ...extra,
  };
}

function answer(
  rows: BookReportRow[],
  over: Partial<BookOrderTotalsResponse> = {},
): BookOrderTotalsResponse {
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    range: {
      key: 'all',
      from: null,
      to: null,
      timeZone: 'America/Los_Angeles',
      timeZoneFallback: false,
    },
    statuses: [],
    filters: { warehouse: null, category: null, uncategorized: false },
    scope: { restricted: false },
    summary: {
      copies: '642',
      entries: rows.length,
      orders: 26,
      lines: 30,
      firstOrderAt: null,
      lastOrderAt: null,
      firstOrderDate: '2026-05-12',
      lastOrderDate: '2026-09-25',
      unresolved: { entries: 0, quantity: '0' },
    },
    totalCount: rows.length,
    mode: 'all',
    tooMany: false,
    maxRows: 20000,
    page: 1,
    pageSize: null,
    sort: 'copies',
    rows,
    organizationId: 'org',
    warehouse: { id: null, source: 'all' },
    ...over,
  };
}

function input(
  a: BookOrderTotalsResponse,
  q = '',
  labels = bookReportStatusLabels(null),
): BookReportExportInput {
  return {
    answer: a,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    statusLabels: labels,
    q,
  };
}

const csvOf = (i: BookReportExportInput) => [...bookReportCsvChunks(i)].join('');

async function parseWithExcel(text: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  const ws = await wb.csv.read(Readable.from([text]));
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    out.push((r.values as unknown[]).slice(1));
  });
  return out;
}

function parseWithPapa(text: string): unknown[][] {
  return Papa.parse<unknown[]>(text, { dynamicTyping: true, skipEmptyLines: true }).data;
}

const FORMULA_START = /^[=+\-@]/;

describe('csv primitives', () => {
  it('quotes a bare carriage return (it used to split a row)', () => {
    expect(csvCell('Book\rTitle')).toBe('"Book\rTitle"');
    expect(toCsv(['t'], [{ t: 'a\rb' }])).toBe('t\n"a\rb"');
  });
  it('defuses formulas in data cells', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-0306406152')).toBe("'-0306406152");
  });
  it('sanitizeCsvText flattens controls and caps at 200 with an ellipsis', () => {
    expect(sanitizeCsvText('a\r\n=b\tc d\u007fe')).toBe('a =b c d e');
    const long = sanitizeCsvText('x'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
  it('a metadata line is ONE quoted cell starting with #', () => {
    expect(csvMetaLine('Search', 'x\n=HYPERLINK("http://e","c")')).toBe(
      '"# Search: x =HYPERLINK(""http://e"",""c"")"',
    );
  });
});

describe('Book Order Totals CSV', () => {
  it('starts with the metadata block, then an empty line and the header', () => {
    const text = csvOf(input(answer([row(1)])));
    const lines = text.split('\n');
    expect(lines[0]).toBe('"# Book Order Totals"');
    expect(lines).toContain('"# Orders placed during: All time (May 12, 2026 – Sep 25, 2026)"');
    expect(lines).toContain('"# Generated: 2026-09-28 10:42 America/Los_Angeles"');
    expect(lines).toContain(
      '"# Total books ordered: 642 copies requested (not purchased, not in stock)"',
    );
    expect(lines).toContain('"# Distinct book entries: 1"');
    expect(lines).toContain('"# Orders containing books: 26"');
    const header = lines.indexOf(BOOK_REPORT_CSV_COLUMNS.join(','));
    expect(header).toBeGreaterThan(5);
    expect(lines[header - 1]).toBe('');
    for (const l of lines.slice(0, header - 1)) expect(l).toMatch(/^"# /);
  });

  it('keeps exact quantity text and never includes a URL', () => {
    const text = csvOf(
      input(answer([row(1, { copies: '12.3456', fulfilled: '8', returned: '2' })])),
    );
    const data = text.split('\n').find((l) => l.startsWith('0e000000'))!;
    expect(data).toContain(',12.3456,');
    expect(text).not.toMatch(/https?:/);
  });

  it('metadata injection: names, a search and a status label cannot start a row or a cell', async () => {
    const a = answer([row(1, { name: '=1+1', sku: '@x', identifier: '-0306406152' })], {
      filters: {
        warehouse: { id: W1, name: 'W\r=1+1', status: 'active' },
        category: { id: 'c', name: "a,=cmd|' /C calc'!A0", deleted: false },
        uncategorized: false,
      },
      warehouse: { id: W1, source: 'explicit' },
    });
    const labels = bookReportStatusLabels({ completed: { label: 'Done "now", =x' } });
    const text = csvOf(input(a, 'x\n=HYPERLINK("http://e","c")', labels));
    // The raw file: no line starts with a formula character.
    for (const line of text.split(/\r\n|\n|\r/)) expect(line).not.toMatch(FORMULA_START);
    for (const parsed of [await parseWithExcel(text), parseWithPapa(text)]) {
      for (const r of parsed) {
        for (const cell of r) {
          if (typeof cell === 'string') expect(cell).not.toMatch(FORMULA_START);
        }
        // Every metadata row is exactly one field.
        if (typeof r[0] === 'string' && (r[0] as string).startsWith('#')) {
          expect(r.filter((c) => c !== null && c !== undefined && c !== '')).toHaveLength(1);
        }
      }
    }
  });

  it('a 500-character value is capped in the metadata', () => {
    const a = answer([row(1)], {
      filters: {
        warehouse: { id: W1, name: 'N'.repeat(500), status: 'active' },
        category: null,
        uncategorized: false,
      },
      warehouse: { id: W1, source: 'explicit' },
    });
    const line = bookReportScopeLines(input(a)).find((l) => l.startsWith('Warehouse:'))!;
    expect(line).toBe(`Warehouse: ${'N'.repeat(199)}…`);
  });

  it('identifiers survive as text in the label columns (the raw column is exact, spreadsheets turn it into a number)', async () => {
    const a = answer([
      row(1, { identifier: '0140449132', sku: '0012' }),
      row(2, { identifier: '9780140449136' }),
    ]);
    const text = csvOf(input(a));
    // Byte-exact raw values in the file.
    expect(text).toContain(',0140449132,');
    expect(text).toContain(',9780140449136,');
    const col = (name: string) =>
      BOOK_REPORT_CSV_COLUMNS.indexOf(name as (typeof BOOK_REPORT_CSV_COLUMNS)[number]);
    const excel = (await parseWithExcel(text)).filter(
      (r) => typeof r[0] === 'string' && (r[0] as string).startsWith('0e000000'),
    );
    expect(excel.map((r) => r[col('identifier_label')])).toEqual([
      'ISBN 0140449132',
      'ISBN 9780140449136',
    ]);
    expect(excel.map((r) => r[col('sku_label')])).toEqual(['SKU 0012', 'SKU BK-2']);
    // Why the label columns exist: a spreadsheet reads the raw column as a
    // number, dropping the leading zero.
    expect(excel[0]![col('identifier')]).toBe(140449132);
    const papa = parseWithPapa(text).filter(
      (r) => typeof r[0] === 'string' && (r[0] as string).startsWith('0e000000'),
    );
    expect(papa.map((r) => r[col('identifier_label')])).toEqual([
      'ISBN 0140449132',
      'ISBN 9780140449136',
    ]);
  });

  it('streams 20,000 rows in chunks of 500 and writes every row once', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => row(i + 1));
    const chunks = [...bookReportCsvChunks(input(answer(rows)))];
    expect(chunks).toHaveLength(1 + 20_000 / BOOK_REPORT_CSV_CHUNK_ROWS);
    const dataLines = chunks.slice(1).join('').split('\n').filter(Boolean);
    expect(dataLines).toHaveLength(20_000);
    expect(new Set(dataLines.map((l) => l.split(',')[0])).size).toBe(20_000);
  });

  it('names quantity columns without "copies": a pack row is not copies', async () => {
    // Brief section 3: quantities are called copies only when they are
    // individual books. The unit and counts_as_copies columns say which.
    for (const c of BOOK_REPORT_CSV_COLUMNS) expect(c).not.toMatch(/^copies_/);
    expect(BOOK_REPORT_CSV_COLUMNS).toEqual(
      expect.arrayContaining([
        'quantity_requested',
        'quantity_recorded_fulfilled',
        'quantity_returned',
        'unit',
        'counts_as_copies',
      ]),
    );
    const text = csvOf(
      input(
        answer([
          row(1, { copies: '30', fulfilled: '8', returned: '2' }),
          row(2, { countsAsCopies: false, unit: 'pack of 10', copies: '3' }),
        ]),
      ),
    );
    expect(text).toContain(
      '"# Quantities are copies only where counts_as_copies is yes; other rows are in the unit shown."',
    );
    const parsed = parseWithPapa(text);
    const header = parsed.find((r) => r[0] === 'item_id')!;
    const pack = parsed.find((r) => r[1] === 'Book 2')!;
    const at = (name: string) => pack[header.indexOf(name)];
    expect([at('quantity_requested'), at('unit'), at('counts_as_copies')]).toEqual([
      3,
      'pack of 10',
      'no',
    ]);
  });

  it('discloses other units, the zone fallback and a restricted scope', () => {
    const a = answer(
      [row(1), row(2, { countsAsCopies: false, unit: 'pack of 10', copies: '12' })],
      {
        summary: { ...answer([]).summary, entries: 2, unresolved: { entries: 1, quantity: '12' } },
        range: {
          key: 'all',
          from: null,
          to: null,
          timeZone: 'America/Los_Angeles',
          timeZoneFallback: true,
        },
        scope: { restricted: true },
      },
    );
    const text = csvOf(input(a));
    expect(text).toContain(
      '"# Not counted as copies: Leaves out 1 book entry ordered in another unit (12 pack of 10)."',
    );
    expect(text).toContain("because the organization's time zone setting could not be used.");
    expect(text).toContain(BOOK_REPORT_RESTRICTED);
    expect(text).toContain('orders for those charters and orders with no charter');
  });
});

describe('the ORDER charter and the date range in the files (0382)', () => {
  const W = '0e000000-0000-4000-8000-0000000000d1';
  const ALDER = {
    id: '0e000000-0000-4000-8000-0000000000a1',
    name: 'Charter Alder',
    code: 'CH-A',
    status: 'active',
  };
  const chartered = (
    charter: typeof ALDER | null,
    noCharter: boolean,
    over: Partial<BookOrderTotalsResponse> = {},
  ) =>
    answer([row(1), row(2)], {
      filters: {
        warehouse: { id: W, name: 'North', status: 'active' },
        category: null,
        uncategorized: false,
        charter,
        noCharter,
      },
      warehouse: { id: W, source: 'explicit' },
      range: {
        key: 'custom',
        from: '2026-09-01',
        to: '2026-09-30',
        timeZone: 'America/Los_Angeles',
        timeZoneFallback: false,
      },
      ...over,
    });

  it('scope lines read charter, dates, status, warehouse, category, search, then generated', () => {
    const lines = bookReportScopeLines(input(chartered(ALDER, false), 'outsiders'));
    expect(lines.map((l) => l.split(':')[0])).toEqual([
      'Charter',
      'Orders placed during',
      'Status',
      'Warehouse',
      'Category',
      'Search',
      'Generated',
    ]);
    expect(lines[0]).toBe('Charter: Charter Alder · CH-A');
    expect(lines[1]).toBe('Orders placed during: Sep 1 – Sep 30, 2026');
  });

  it('All charters, No charter, and an answer from before 0382 (no charter keys)', () => {
    expect(bookReportScopeLines(input(chartered(null, false)))[0]).toBe('Charter: All charters');
    expect(bookReportScopeLines(input(chartered(null, true)))[0]).toBe(
      'Charter: No charter (pickup orders and orders placed without a charter)',
    );
    // A 0379 answer carries neither key: it can only be All charters.
    expect(bookReportScopeLines(input(answer([row(1)])))[0]).toBe('Charter: All charters');
  });

  it('an archived charter says so; a code equal to the name is not repeated', () => {
    const archived = { ...ALDER, name: 'Old', code: 'old', status: 'archived' };
    expect(bookReportScopeLines(input(chartered(archived, false)))[0]).toBe(
      'Charter: Old (archived)',
    );
  });

  it('two constant trailing columns; every earlier column keeps its position', () => {
    expect(BOOK_REPORT_CSV_COLUMNS.slice(0, 19)).toEqual([
      'item_id',
      'title',
      'sku',
      'sku_label',
      'identifier_type',
      'identifier',
      'identifier_label',
      'item_warehouse',
      'rack_or_bin',
      'unit',
      'counts_as_copies',
      'quantity_requested',
      'orders',
      'latest_order_date',
      'latest_order_at',
      'quantity_recorded_fulfilled',
      'quantity_returned',
      'item_status',
      'now_rental',
    ]);
    expect(BOOK_REPORT_CSV_COLUMNS.slice(19)).toEqual(['charter_scope', 'date_range']);
    const parsed = parseWithPapa(csvOf(input(chartered(ALDER, false))));
    const header = parsed.find((r) => r[0] === 'item_id')!;
    const data = parsed.filter((r) => typeof r[0] === 'string' && r[0].startsWith('0e000000'));
    expect(data).toHaveLength(2);
    for (const r of data) {
      expect(r).toHaveLength(header.length);
      expect(r[header.indexOf('charter_scope')]).toBe('Charter Alder · CH-A');
      expect(r[header.indexOf('date_range')]).toBe('2026-09-01 to 2026-09-30');
    }
    expect(csvOf(input(chartered(ALDER, false)))).toContain(
      '"# charter_scope and date_range repeat the Charter and Orders placed lines above on every row."',
    );
  });

  it('date_range: All time, or the resolved org-local days of any other range', () => {
    expect(bookReportExportDateRange({ key: 'all', from: null, to: null })).toBe('All time');
    expect(bookReportExportDateRange({ key: 'week', from: '2026-09-27', to: '2026-09-29' })).toBe(
      '2026-09-27 to 2026-09-29',
    );
    expect(bookReportExportDateRange({ key: 'today', from: '2026-09-29', to: '2026-09-29' })).toBe(
      '2026-09-29 to 2026-09-29',
    );
    // Never re-zoned, never invented: a preset without its days says its name.
    expect(bookReportExportDateRange({ key: 'month', from: null, to: null })).toBe('This month');
  });

  it('a charter name that starts a formula or holds a newline is neutralized in the line and the column', async () => {
    const evil = {
      ...ALDER,
      name: '=HYPERLINK("http://e","c")\n@SUM(1)',
      code: '+1\r-2',
    };
    const text = csvOf(input(chartered(evil, false)));
    for (const line of text.split(/\r\n|\n|\r/)) expect(line).not.toMatch(FORMULA_START);
    // One physical line per record: the newline inside the name never splits a row.
    const physical = text.split('\n').filter(Boolean);
    const header = physical.findIndex((l) => l.startsWith('item_id,'));
    expect(physical.length - header - 1).toBe(2);
    expect(physical.some((l) => l.startsWith('"# Charter: =HYPERLINK'))).toBe(true);
    for (const parsed of [await parseWithExcel(text), parseWithPapa(text)]) {
      for (const r of parsed) {
        for (const cell of r) {
          if (typeof cell === 'string') expect(cell).not.toMatch(FORMULA_START);
        }
        if (typeof r[0] === 'string' && (r[0] as string).startsWith('#')) {
          expect(r.filter((c) => c !== null && c !== undefined && c !== '')).toHaveLength(1);
        }
      }
      const headerRow = parsed.find((r) => r[0] === 'item_id')!;
      const scopeCells = parsed
        .filter((r) => typeof r[0] === 'string' && (r[0] as string).startsWith('0e000000'))
        .map((r) => String(r[headerRow.indexOf('charter_scope')]));
      expect(scopeCells).toHaveLength(2);
      for (const c of scopeCells) {
        expect(c).not.toMatch(/[\r\n]/);
        expect(c).toContain('HYPERLINK');
      }
    }
  });
});
