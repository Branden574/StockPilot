import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CSV of a report is the same file for the same data (2026-09-29).
 *
 * After deploy #293, Demo Co's Stock movements CSV had the same rows as
 * before, but `initial` and `bundle_distribution` (3 each) had swapped
 * places: the SQL groups with no ORDER BY and ties kept its row order. Anyone
 * comparing two exports read that as changed data. The item cost history CSV
 * also sorted by the calendar day alone, so two prices on one day could come
 * out in the other order from the page.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('the CSV path must not use the service-role client');
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { GET } from './route';

const ITEM = '11111111-2222-4333-8444-555555555555';

function signIn(results: Record<string, QueryResult>) {
  const s = makeSupabaseStub(results);
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(s.client, { role: 'manager' }) as never,
  );
}

async function csv(slug: string, qs = '') {
  const res = await GET(new Request(`https://test.local/api/reports/${slug}/csv${qs}`), {
    params: Promise.resolve({ slug }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
});

describe('GET /api/reports/stock-movements/csv: tied movement types', () => {
  const types = [
    { movement_type: 'add', movement_count: 7, total_qty: 70 },
    { movement_type: 'initial', movement_count: 3, total_qty: 90 },
    { movement_type: 'bundle_distribution', movement_count: 3, total_qty: 12 },
    { movement_type: 'adjust', movement_count: 1, total_qty: 1 },
  ];

  async function exportWith(rows: typeof types) {
    signIn({
      'rpc:report_movement_type_summary': { data: rows, error: null },
      'rpc:report_top_movers': { data: [], error: null },
    });
    return csv('stock-movements', '?days=30');
  }

  it('the same file whichever order the function returns the types in', async () => {
    const forward = await exportWith(types);
    const reversed = await exportWith([...types].reverse());
    expect(reversed).toBe(forward);
    const byType = forward.split('# Top movers')[0]!;
    expect(byType.indexOf('bundle_distribution')).toBeLessThan(byType.indexOf('initial'));
    expect(byType.indexOf('add')).toBeLessThan(byType.indexOf('bundle_distribution'));
  });
});

describe('GET /api/reports/item-cost-history/csv: the page order', () => {
  // PO lines as the service reads them: one supplier bought at 15:00, the
  // other at 09:00 on the same day. The service lists the later supplier's
  // series first (most recent observation first).
  const poLines = [
    {
      id: 'l1',
      unit_cost: 10,
      purchase_order_id: 'po-a',
      po: {
        id: 'po-a',
        supplier_id: 's-acme',
        ordered_at: '2026-05-01T15:00:00+00:00',
        created_at: '2026-05-01T15:00:00+00:00',
        supplier: { name: 'Acme' },
      },
    },
    {
      id: 'l2',
      unit_cost: 12,
      purchase_order_id: 'po-z',
      po: {
        id: 'po-z',
        supplier_id: 's-zed',
        ordered_at: '2026-05-01T09:00:00+00:00',
        created_at: '2026-05-01T09:00:00+00:00',
        supplier: { name: 'Zed Supply' },
      },
    },
  ];

  it('two prices on one day come out in time order, as on the page', async () => {
    signIn({
      'inventory_items.select': { data: { id: ITEM }, error: null },
      'purchase_order_items.select': { data: poLines, error: null },
      'receipt_lines.select': { data: [], error: null },
    });
    const body = await csv('item-cost-history', `?itemId=${ITEM}`);
    const lines = body.trim().split(/\r?\n/);
    expect(lines.slice(1)).toEqual([
      'Zed Supply,2026-05-01,PO,12.0000',
      'Acme,2026-05-01,PO,10.0000',
    ]);
  });
});
