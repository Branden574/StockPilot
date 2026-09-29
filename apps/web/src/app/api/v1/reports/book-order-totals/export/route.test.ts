// Security invariant: the Book Order Totals export route. reports:export (with
// the MFA step-up) is checked BEFORE the shared export rate limit, so a
// refused caller never spends the budget; the query must name its warehouse;
// the file comes from ONE export-mode statement and is refused (400
// too_many_rows) above its ceiling before any byte or audit row; the audit
// row is awaited before the body streams; the body is streamed (no
// Content-Length) and never cached; the filename carries the org-local date.
// The ORDER's charter (0382): the file covers that charter's orders (every
// row, never the page), its audit row names the charter by id ('none' / 'all'
// otherwise), the filename never names it, and the budget order is pinned: a
// charter the caller may not report on is refused by the database INSIDE the
// export statement, after one of the caller's own export slots was taken,
// with the same 400 body the page route gives.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co' } }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/lib/pdf/image-prefetch', () => ({
  prefetchImagesAsDataUris: vi.fn(async () => new Map()),
}));

import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { audit } from '@/server/services/audit';
import { BookOrderTotalsService } from '@/server/services/book-order-totals';

import { GET as pageGET } from '../route';
import { GET } from './route';

const W1 = '0e000000-0000-4000-8000-0000000000d1';
const ITEM = '0e000000-0000-4000-8000-000000000f01';
const CH_A = '0e000000-0000-4000-8000-0000000000a1';
const OUT_OF_SCOPE = '0e000000-0000-4000-8000-0000000000a2';
const ALDER = { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' };
const INVALID_CHARTER = { code: '22023', hint: 'invalid_charter', message: 'invalid charter' };

function exportAnswer(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    generatedAt: '2026-09-29T02:10:00+00:00',
    generatedAtLocal: '2026-09-28 19:10',
    range: {
      key: 'all',
      from: null,
      to: null,
      timeZone: 'America/Los_Angeles',
      timeZoneFallback: false,
    },
    statuses: ['pending_approval'],
    filters: {
      warehouse: { id: W1, name: 'North', status: 'active' },
      category: null,
      uncategorized: false,
    },
    scope: { restricted: false },
    summary: {
      copies: '30',
      entries: 1,
      orders: 3,
      lines: 3,
      firstOrderAt: null,
      lastOrderAt: null,
      firstOrderDate: null,
      lastOrderDate: null,
      unresolved: { entries: 0, quantity: '0' },
    },
    totalCount: 1,
    mode: 'all',
    tooMany: false,
    maxRows: 20000,
    page: 1,
    pageSize: null,
    sort: 'copies',
    rows: [
      {
        itemId: ITEM,
        name: 'Book A',
        sku: 'BK-A',
        identifier: '9780140449136',
        binLocation: 'R1-A',
        unit: 'unit',
        countsAsCopies: true,
        warehouseId: W1,
        warehouseName: 'North',
        itemStatus: 'active',
        deleted: false,
        nowRental: false,
        copies: '30',
        orders: 3,
        lines: 3,
        latestOrderAt: '2026-04-01T06:59:00+00:00',
        latestOrderDate: '2026-03-31',
        fulfilled: '8',
        returned: '2',
      },
    ],
    ...over,
  };
}

function setup(
  over: Parameters<typeof makeServiceContext>[1] = {},
  answer: unknown = exportAnswer(),
) {
  const stub = makeSupabaseStub({
    'rpc:book_order_totals': { data: answer, error: null },
    'organizations.select': {
      data: [{ name: 'Demo Co', logo_url: null, order_status_config: null }],
      error: null,
    },
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-1',
    role: 'manager',
    ...over,
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

const url = (qs: string) =>
  new Request(`http://localhost/api/v1/reports/book-order-totals/export?${qs}`) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
});

describe('GET /api/v1/reports/book-order-totals/export', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await GET(url('format=csv&warehouse=all'))).status).toBe(401);
  });

  it('403 without reports:export, and the rate limiter is never consulted', async () => {
    const stub = setup({ role: 'staff' });
    const res = await GET(url('format=csv&warehouse=all'));
    expect(res.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('403 at a required MFA step-up, with its reason, before the limiter', async () => {
    setup({ mfaRequired: true, mfaSatisfied: false });
    const res = await GET(url('format=csv&warehouse=all'));
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'mfa_required' });
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('400 when the query names no warehouse (never the view cookie), before the limiter', async () => {
    setup();
    const res = await GET(url('format=csv'));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'warehouse_required' });
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('400 for an unknown format or photos value', async () => {
    setup();
    expect((await GET(url('format=xlsx&warehouse=all'))).status).toBe(400);
    expect((await GET(url('format=pdf&photos=yes&warehouse=all'))).status).toBe(400);
  });

  it('429 when the shared export budget is spent, before any read', async () => {
    const stub = setup();
    vi.mocked(exportRateLimited).mockResolvedValue(
      NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    );
    expect((await GET(url('format=csv&warehouse=all'))).status).toBe(429);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('400 too_many_rows above the ceiling: no file, no audit row', async () => {
    setup(
      {},
      exportAnswer({
        tooMany: true,
        rows: [],
        totalCount: 21340,
        summary: { ...exportAnswer().summary, entries: 21340 },
      }),
    );
    const res = await GET(url('format=csv&warehouse=all'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toEqual({ reason: 'too_many_rows', count: 21340, limit: 20000 });
    expect(body.message).toBe(
      'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.',
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it('CSV: one export-mode statement, audited first, streamed, never cached, org-local filename', async () => {
    const stub = setup();
    const res = await GET(url(`format=csv&warehouse=${W1}&wview=1&q=hobbit`));
    expect(res.status).toBe(200);
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_all_rows: true,
      p_max_rows: 20000,
      p_warehouse_id: W1,
      p_organization_id: 'org-1',
    });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // 2026-09-29T02:10Z is still Sep 28 in Los Angeles: the file is named by the org's day.
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="book-order-totals_2026-09-28.csv"',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(audit).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toMatchObject({
      event: 'report.exported',
      entityType: 'report',
      extra: {
        slug: 'book-order-totals',
        format: 'csv',
        rows: 1,
        copies: '30',
        warehouse: W1,
        warehouseSource: 'view',
        searchLength: 6,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('hobbit');
    const text = await res.text();
    expect(text).toContain('"# Warehouse: North (your warehouse view)"');
    expect(text).toContain(`${ITEM},Book A,BK-A,SKU BK-A,ISBN,9780140449136,ISBN 9780140449136`);
    expect(text).not.toMatch(/https?:/);
  });

  it('PDF with covers: a cover lookup that failed is counted as could not be loaded, never as no cover', async () => {
    setup();
    const spy = vi
      .spyOn(BookOrderTotalsService.prototype, 'pdfCovers')
      .mockResolvedValue({ urls: {}, unresolved: [ITEM] });
    const res = await GET(url('format=pdf&photos=1&warehouse=all'));
    expect(res.status).toBe(200);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      event: 'pdf.exported',
      extra: { photos: true, coversShown: 0, coversFailed: 1, coversPastCap: 0 },
    });
    spy.mockRestore();
  });

  it('PDF without covers: inline, audited as pdf.exported, a real PDF body', async () => {
    setup();
    const res = await GET(url('format=pdf&photos=0&warehouse=all'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'inline; filename="book-order-totals_2026-09-28.pdf"',
    );
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      event: 'pdf.exported',
      extra: { photos: false, format: 'pdf' },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it("budget order: a refused charter takes one of the caller's own export slots, then the same 400 as the page", async () => {
    const order: string[] = [];
    vi.mocked(exportRateLimited).mockImplementation(async () => {
      order.push('budget');
      return null;
    });
    // The export-mode statement is where the database judges the charter.
    const refused = () => {
      order.push('statement');
      return { data: null, error: INVALID_CHARTER };
    };
    const ctx = makeServiceContext(makeSupabaseStub({ 'rpc:book_order_totals': refused }).client, {
      organizationId: 'org-1',
      role: 'manager',
    });
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);
    const res = await GET(url(`format=csv&warehouse=all&charter=${OUT_OF_SCOPE}`));
    expect(res.status).toBe(400);
    expect(order).toEqual(['budget', 'statement']);
    expect(exportRateLimited).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
    const exportBody = await res.json();
    expect(exportBody).toEqual({
      error: 'validation_error',
      message: 'That charter is not one you can see.',
      details: { reason: 'invalid_charter' },
    });
    expect(JSON.stringify(exportBody)).not.toContain(OUT_OF_SCOPE);
    // The page route's refusal for the same id reads the same.
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(
        makeSupabaseStub({ 'rpc:book_order_totals': { data: null, error: INVALID_CHARTER } })
          .client,
        { organizationId: 'org-1', role: 'manager' },
      ) as never,
    );
    const page = await pageGET(
      new Request(
        `http://localhost/api/v1/reports/book-order-totals?warehouse=all&charter=${OUT_OF_SCOPE}`,
      ) as never,
    );
    expect(page.status).toBe(400);
    expect(await page.json()).toEqual(exportBody);
  });

  it('a malformed charter is a 400 naming charter before the limiter', async () => {
    const stub = setup();
    const res = await GET(url('format=csv&warehouse=all&charter=alder'));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'invalid_query', keys: ['charter'] });
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('All charters: no charter key on the wire, audited as charter "all"', async () => {
    const stub = setup();
    expect((await GET(url('format=csv&warehouse=all'))).status).toBe(200);
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    expect(Object.keys(args).filter((k) => /charter/.test(k))).toEqual([]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ extra: { charter: 'all' } });
  });

  it('a charter and exact dates: every row of that charter, its scope in the file, its id in the audit row, never its name in the filename', async () => {
    const stub = setup(
      {},
      exportAnswer({
        range: {
          key: 'custom',
          from: '2026-09-01',
          to: '2026-09-30',
          timeZone: 'America/Los_Angeles',
          timeZoneFallback: false,
        },
        filters: {
          warehouse: null,
          category: null,
          uncategorized: false,
          charter: ALDER,
          noCharter: false,
        },
        byCharter: null,
      }),
    );
    const res = await GET(
      url(`format=csv&warehouse=all&charter=${CH_A}&from=2026-09-01&to=2026-09-30`),
    );
    expect(res.status).toBe(200);
    // ONE export-mode statement (and, beside it, the charter list for the
    // file's labels).
    expect(stub.rpcCalls.filter((c) => c.name === 'book_order_totals')).toHaveLength(1);
    const args = stub.rpcCalls.find((c) => c.name === 'book_order_totals')!.args as Record<
      string,
      unknown
    >;
    expect(args).toMatchObject({
      p_charter_id: CH_A,
      p_range: 'custom',
      p_from_date: '2026-09-01',
      p_to_date: '2026-09-30',
      p_all_rows: true,
      p_page: 1,
      p_page_size: null,
    });
    expect(args).not.toHaveProperty('p_no_charter');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="book-order-totals_2026-09-28.csv"',
    );
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      event: 'report.exported',
      extra: { charter: CH_A, range: 'custom', from: '2026-09-01', to: '2026-09-30' },
    });
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toContain('Alder');
    const text = await res.text();
    const lines = text.split('\n');
    // The charter line comes first in the scope, before the dates.
    expect(lines[1]).toBe('"# Charter: Charter Alder · CH-A"');
    expect(lines[2]).toBe('"# Orders placed during: Sep 1 – Sep 30, 2026"');
    const header = lines.find((l) => l.startsWith('item_id,'))!;
    expect(header.endsWith(',charter_scope,date_range')).toBe(true);
    const data = lines.find((l) => l.startsWith(ITEM))!;
    expect(data.endsWith(',Charter Alder · CH-A,2026-09-01 to 2026-09-30')).toBe(true);
  });

  it("two same-named charters: the file names the charter with the page's tie-broken label, read beside the statement", async () => {
    const plain = { ...ALDER, code: null };
    const twin = { ...plain, id: OUT_OF_SCOPE };
    const stub = makeSupabaseStub({
      'rpc:book_order_totals': {
        data: exportAnswer({
          filters: {
            warehouse: null,
            category: null,
            uncategorized: false,
            charter: plain,
            noCharter: false,
          },
        }),
        error: null,
      },
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [],
          categories: [],
          uncategorized: false,
          charters: [plain, twin],
          noCharter: false,
          orderStatusConfig: null,
        },
        error: null,
      },
      'organizations.select': {
        data: [{ name: 'Demo Co', logo_url: null, order_status_config: null }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, { organizationId: 'org-1', role: 'manager' });
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);
    const res = await GET(url(`format=csv&warehouse=all&charter=${CH_A}`));
    expect(res.status).toBe(200);
    expect(stub.rpcCalls.map((c) => c.name).sort()).toEqual([
      'book_order_totals',
      'book_order_totals_options',
    ]);
    const text = await res.text();
    expect(text.split('\n')[1]).toBe(`"# Charter: Charter Alder (id ${CH_A})"`);
    expect(text.split('\n').find((l) => l.startsWith(ITEM))).toContain(
      `,Charter Alder (id ${CH_A}),`,
    );
    // Never the name in the audit row or the filename.
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toContain('Alder');
  });

  it('the charter list is read only for a chosen charter, and a failed read leaves the plain label', async () => {
    const stub = setup();
    expect((await GET(url('format=csv&warehouse=all'))).status).toBe(200);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['book_order_totals']);
    const none = setup(
      {},
      exportAnswer({
        filters: {
          warehouse: null,
          category: null,
          uncategorized: false,
          charter: null,
          noCharter: true,
        },
      }),
    );
    expect((await GET(url('format=csv&warehouse=all&charter=none'))).status).toBe(200);
    expect(none.rpcCalls.map((c) => c.name)).toEqual(['book_order_totals']);
    // The list cannot be read: the file still comes, named from the echo.
    const failing = makeSupabaseStub({
      'rpc:book_order_totals': {
        data: exportAnswer({
          filters: {
            warehouse: null,
            category: null,
            uncategorized: false,
            charter: ALDER,
            noCharter: false,
          },
        }),
        error: null,
      },
      'rpc:book_order_totals_options': { data: null, error: { code: '57014', message: 'timeout' } },
      'organizations.select': {
        data: [{ name: 'Demo Co', logo_url: null, order_status_config: null }],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(failing.client, { organizationId: 'org-1', role: 'manager' }) as never,
    );
    const res = await GET(url(`format=csv&warehouse=all&charter=${CH_A}`));
    expect(res.status).toBe(200);
    expect((await res.text()).split('\n')[1]).toBe('"# Charter: Charter Alder · CH-A"');
  });

  it('No charter: audited as "none", the file says No charter', async () => {
    const stub = setup(
      {},
      exportAnswer({
        filters: {
          warehouse: null,
          category: null,
          uncategorized: false,
          charter: null,
          noCharter: true,
        },
      }),
    );
    const res = await GET(url('format=csv&warehouse=all&charter=none'));
    expect(res.status).toBe(200);
    expect(stub.rpcCalls[0]!.args).toMatchObject({ p_no_charter: true });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ extra: { charter: 'none' } });
    const text = await res.text();
    expect(text).toContain(
      '"# Charter: No charter (pickup orders and orders placed without a charter)"',
    );
    expect(
      text
        .split('\n')
        .find((l) => l.startsWith(ITEM))!
        .endsWith(',No charter,All time'),
    ).toBe(true);
  });

  it('PDF with a charter: audited with the charter, covers cap unchanged', async () => {
    setup(
      {},
      exportAnswer({
        filters: {
          warehouse: null,
          category: null,
          uncategorized: false,
          charter: ALDER,
          noCharter: false,
        },
      }),
    );
    const spy = vi
      .spyOn(BookOrderTotalsService.prototype, 'pdfCovers')
      .mockResolvedValue({ urls: {}, unresolved: [] });
    const res = await GET(url(`format=pdf&photos=1&warehouse=all&charter=${CH_A}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'inline; filename="book-order-totals_2026-09-28.pdf"',
    );
    expect(spy).toHaveBeenCalledWith([ITEM]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      event: 'pdf.exported',
      extra: { charter: CH_A, coversPastCap: 0 },
    });
    spy.mockRestore();
  });
});
