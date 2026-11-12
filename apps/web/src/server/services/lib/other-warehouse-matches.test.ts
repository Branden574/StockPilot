import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { createClient } from '@/lib/supabase/server';

import { countMatchesInOtherWarehouses } from './other-warehouse-matches';

/**
 * The count behind the Items and Books pages' "Nothing here in <warehouse>"
 * hint: the view's own records (products or books), active and received, in
 * every warehouse, narrowed by the search alone, through the user's client.
 */

const calls: Array<[string, ...unknown[]]> = [];

function client(answer: { count: number | null; error: unknown }) {
  // The query is the thenable, never the client (a thenable client would be
  // adopted by createClient's own promise).
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'is', 'or']) {
    q[k] = (...args: unknown[]) => {
      calls.push([k, ...args]);
      return q;
    };
  }
  q.then = (resolve: (v: unknown) => unknown) => resolve(answer);
  return {
    from: (table: string) => {
      calls.push(['from', table]);
      return q;
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(createClient).mockReset();
});

describe('countMatchesInOtherWarehouses', () => {
  it.each<['items' | 'books', string]>([
    ['items', 'product'],
    ['books', 'book'],
  ])(
    "%s: counts the view's own active, received records in the organization",
    async (view, itemType) => {
      vi.mocked(createClient).mockResolvedValue(client({ count: 4, error: null }) as never);
      await expect(countMatchesInOtherWarehouses('org-1', {}, view)).resolves.toBe(4);
      expect(calls).toEqual([
        ['from', 'inventory_items'],
        ['select', 'id', { count: 'exact', head: true }],
        ['eq', 'organization_id', 'org-1'],
        ['is', 'deleted_at', null],
        ['eq', 'status', 'active'],
        ['eq', 'item_type', itemType],
        ['eq', 'is_rental', false],
        ['eq', 'awaiting_first_receipt', false],
      ]);
    },
  );

  it('a search narrows by name, SKU or barcode, with the filter syntax characters dropped', async () => {
    vi.mocked(createClient).mockResolvedValue(client({ count: 1, error: null }) as never);
    await countMatchesInOtherWarehouses('org-1', { q: ' Grade (2), 100% ' }, 'books');
    expect(calls.at(-1)).toEqual([
      'or',
      'name.ilike.*Grade  2   100*,sku.ilike.*Grade  2   100*,barcode.ilike.*Grade  2   100*',
    ]);
  });

  it('a search of filter syntax alone is no search', async () => {
    vi.mocked(createClient).mockResolvedValue(client({ count: 1, error: null }) as never);
    await countMatchesInOtherWarehouses('org-1', { q: ' %,() ' }, 'items');
    expect(calls.some(([k]) => k === 'or')).toBe(false);
  });

  it('a refused count, a missing count or a failed client is 0: the ordinary empty state', async () => {
    vi.mocked(createClient).mockResolvedValue(
      client({ count: null, error: { message: 'denied' } }) as never,
    );
    await expect(countMatchesInOtherWarehouses('org-1', {}, 'items')).resolves.toBe(0);
    vi.mocked(createClient).mockResolvedValue(client({ count: null, error: null }) as never);
    await expect(countMatchesInOtherWarehouses('org-1', {}, 'items')).resolves.toBe(0);
    vi.mocked(createClient).mockRejectedValue(new Error('auth down'));
    await expect(countMatchesInOtherWarehouses('org-1', {}, 'books')).resolves.toBe(0);
  });
});
