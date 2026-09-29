// Security invariant: the Book Order Totals export route. reports:export (with
// the MFA step-up) is checked BEFORE the shared export rate limit, so a
// refused caller never spends the budget; the query must name its warehouse;
// the file comes from ONE export-mode statement and is refused (400
// too_many_rows) above its ceiling before any byte or audit row; the audit
// row is awaited before the body streams; the body is streamed (no
// Content-Length) and never cached; the filename carries the org-local date.
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

import { GET } from './route';

const W1 = '0e000000-0000-4000-8000-0000000000d1';
const ITEM = '0e000000-0000-4000-8000-000000000f01';

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
});
