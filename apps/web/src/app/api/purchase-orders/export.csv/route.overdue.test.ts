import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Export CSV on the purchase orders list's Overdue view (small fixes slice 8,
 * item E). The list's Export button sends the view (?status=overdue). The
 * export knew only the status tabs, so an unknown tab exported All. It now
 * exports exactly the view's rows: PurchaseOrdersService.listOverdue, the
 * dashboard count's own filter, for the warehouse the list was showing, then
 * the list's search.
 */

const list = vi.fn();
const listOverdue = vi.fn();

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: class {
    list = list;
    listOverdue = listOverdue;
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: class {
    listForLookups = vi.fn(async () => [
      { id: 'sup-1', name: 'Acme Paper' },
      { id: 'sup-2', name: 'TechSource' },
    ]);
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { makeServiceContext } from '@/test/supabase-mock';

import { GET } from './route';

function po(n: number, status: string, supplier: string | null) {
  return {
    id: `po-${n}`,
    po_number: `PO-${n}`,
    status,
    supplier_id: supplier,
    expected_at: '2026-10-01T00:00:00.000Z',
    ordered_at: '2026-09-20T19:00:00.000Z',
    total: 10,
    created_at: '2026-09-20T19:00:00.000Z',
    line_count: 1,
  };
}

async function exportCsv(query: string) {
  const res = await GET(new Request(`https://test.local/api/purchase-orders/export.csv?${query}`));
  return { res, text: await res.text() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(makeServiceContext({}, { role: 'owner' }) as never);
  list.mockResolvedValue([
    po(1, 'ordered', 'sup-1'),
    po(2, 'received', 'sup-2'),
    po(3, 'ordered', 'sup-2'),
    // Ordered, and expected next week: open, not overdue.
    { ...po(4, 'ordered', 'sup-2'), expected_at: '2026-10-20T00:00:00.000Z' },
  ]);
  listOverdue.mockResolvedValue({
    rows: [po(1, 'ordered', 'sup-1'), po(3, 'ordered', 'sup-2')],
    asOfDay: '2026-10-11',
  });
});

describe('Export CSV of the Overdue view', () => {
  it('exports the overdue purchase orders the view lists, for the warehouse it showed', async () => {
    const { res, text } = await exportCsv('status=overdue&warehouse=wh-1');
    expect(res.status).toBe(200);
    expect(listOverdue).toHaveBeenCalledWith({ warehouseId: 'wh-1' });
    expect(list).not.toHaveBeenCalled();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(text).toContain('PO-1');
    expect(text).toContain('PO-3');
    expect(text).not.toContain('PO-2');
    expect(text).not.toContain('PO-4');
    expect(res.headers.get('content-disposition')).toMatch(/purchase-orders-\d{4}-\d{2}-\d{2}-overdue\.csv/);
  });

  it("with the list's search: PO number or supplier, any case", async () => {
    const { text } = await exportCsv('status=overdue&q=techsource');
    expect(text).toContain('PO-3');
    expect(text).not.toContain('PO-1');
    expect(text).not.toContain('PO-4');
  });

  it('the status views still export by status', async () => {
    const { text } = await exportCsv('status=received');
    expect(listOverdue).not.toHaveBeenCalled();
    expect(text).toContain('PO-2');
    expect(text).not.toContain('PO-1');
  });
});
