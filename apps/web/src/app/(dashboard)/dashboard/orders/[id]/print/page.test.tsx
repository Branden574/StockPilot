// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The printed pick list's bins. The page read every line's bin in one
 * `.in('id', …)` with the error ignored: an order's lines have no total cap,
 * so past ~215 items the local gateway answered 414 and past ~395 production
 * failed after ~7 s of retries, and the list printed with no bins in no walk
 * order. Now 100 ids per request, paged, and a failed read fails the page.
 */

const { stubRef, orderGet } = vi.hoisted(() => ({
  stubRef: { current: null as unknown },
  orderGet: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/components/orders/auto-print', () => ({ AutoPrint: () => null }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'admin' })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({ getCachedOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => stubRef.current) }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ get: orderGet })) },
}));

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import OrderPrintPage from './page';

const itemId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const lines = Array.from({ length: 250 }, (_, i) => ({
  id: `line-${i}`,
  quantity_requested: 1,
  item: { id: itemId(i), name: `Item ${i}`, sku: `S-${i}` },
}));

beforeEach(() => {
  vi.clearAllMocks();
  orderGet.mockResolvedValue({
    request: {
      id: '11111111-1111-1111-1111-111111111111',
      warehouse_id: 'wh-1',
      status: 'approved',
      created_at: '2026-09-01T00:00:00Z',
      approved_at: null,
      notes: null,
    },
    lines,
    warehouseName: 'DC4',
    requesterDisplay: 'Pat',
  });
});

function stubWith(bins: (call: MockCall) => { data: unknown; error: unknown }) {
  const stub = makeSupabaseStub({
    'organizations.select': { data: { name: 'Acme', logo_url: null }, error: null },
    'warehouses.select': { data: null, error: null },
    'inventory_items.select': bins as never,
  });
  stubRef.current = stub.client;
  return stub;
}

describe('order print page with 250 lines', () => {
  it('reads bins 100 ids at a time and walks the list by bin, starting with a bin from the last batch', async () => {
    const lists: string[][] = [];
    stubWith((call) => {
      const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
      lists.push(ids);
      // Only item 249 (in the last batch) has a bin, so it prints first.
      return {
        data: ids.map((id) => ({ id, bin_location: id === itemId(249) ? 'A-01' : null })),
        error: null,
      };
    });

    render(await OrderPrintPage({ params: Promise.resolve({ id: 'o1' }) }));

    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    const firstRow = screen.getAllByRole('row')[1]!;
    expect(firstRow.textContent).toContain('A-01');
    expect(firstRow.textContent).toContain('Item 249');
  });

  it('a failed bin batch fails the page, never a pick list with no bins', async () => {
    let n = 0;
    stubWith(() =>
      ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    );
    await expect(OrderPrintPage({ params: Promise.resolve({ id: 'o1' }) })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('order print page: a line whose item the reader cannot read', () => {
  // The order page and the phone name it with core's label; the printed pick
  // list said "Deleted item" (a line's item cannot be deleted: ON DELETE
  // RESTRICT; a missing item is one the reader's access hides).
  it('prints "An item you can\'t see", never "Deleted item"', async () => {
    orderGet.mockResolvedValue({
      request: {
        id: '11111111-1111-1111-1111-111111111111',
        warehouse_id: 'wh-1',
        status: 'approved',
        created_at: '2026-09-01T00:00:00Z',
        approved_at: null,
        notes: null,
      },
      lines: [
        {
          id: 'line-a',
          quantity_requested: 2,
          item: { id: itemId(1), name: 'Item 1', sku: 'S-1' },
        },
        { id: 'line-b', quantity_requested: 3, item: null },
      ],
      warehouseName: 'DC4',
      requesterDisplay: 'Pat',
    });
    stubWith(() => ({ data: [{ id: itemId(1), bin_location: null }], error: null }));

    render(await OrderPrintPage({ params: Promise.resolve({ id: 'o1' }) }));

    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    expect(rows.some((t) => t.includes("An item you can't see"))).toBe(true);
    expect(rows.join('\n')).not.toMatch(/Deleted item|Unknown item/);
  });
});

// L91: the printout named the order "Order #11111111" while the app and its
// emails name it SO-000049.
describe('order print page: the order is named by its number (L91)', () => {
  const request = {
    id: '11111111-1111-1111-1111-111111111111',
    warehouse_id: 'wh-1',
    status: 'approved',
    created_at: '2026-09-01T00:00:00Z',
    approved_at: null,
    notes: null,
  };

  it('an order with a number prints "Order SO-000049" in the header and the footer', async () => {
    orderGet.mockResolvedValue({
      request: { ...request, order_number: 49 },
      lines: [],
      warehouseName: 'DC4',
      requesterDisplay: 'Pat',
    });
    stubWith(() => ({ data: [], error: null }));

    const { container } = render(await OrderPrintPage({ params: Promise.resolve({ id: 'o1' }) }));

    const text = container.textContent ?? '';
    expect(text.match(/Order SO-000049/g)).toHaveLength(2);
    expect(text).not.toContain('Order #');
  });

  it('an order without one keeps the short id', async () => {
    orderGet.mockResolvedValue({
      request: { ...request, order_number: null },
      lines: [],
      warehouseName: 'DC4',
      requesterDisplay: 'Pat',
    });
    stubWith(() => ({ data: [], error: null }));

    const { container } = render(await OrderPrintPage({ params: Promise.resolve({ id: 'o1' }) }));

    expect((container.textContent ?? '').match(/Order #11111111/g)).toHaveLength(2);
  });
});
