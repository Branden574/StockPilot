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
