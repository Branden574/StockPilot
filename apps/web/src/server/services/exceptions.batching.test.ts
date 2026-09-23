import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exception Center batches its reserved-item read (every item with an
 * open reservation, org-wide, has no ceiling) and settles each rule group on
 * its own, so one failed read names its rules in `failedRules` instead of
 * blanking the page or reading as "nothing wrong".
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ExceptionsService } from './exceptions';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, p?: string) => Array.from({ length: n }, (_, i) => uuid(i, p));

function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}

beforeEach(() => {
  reportError.mockClear();
});

describe('ExceptionsService with many reserved items', () => {
  function svcFor(opts: {
    reservedItems: string[];
    failItemsBatch?: number;
    failHoldings?: boolean;
  }) {
    let itemCalls = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'item_stock_levels.select': () =>
        opts.failHoldings
          ? { data: null, error: { message: 'holdings read failed' } }
          : { data: [], error: null },
      'stock_reservations.select': {
        data: opts.reservedItems.map((item_id) => ({ item_id, quantity: 5 })),
        error: null,
      },
      'inventory_items.select': (call) => {
        itemCalls += 1;
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        if (itemCalls === opts.failItemsBatch) return { data: null, error: { message: 'boom' } };
        // Every reserved item has 1 on hand against 5 promised.
        return {
          data: list.map((id) => ({ id, name: id, sku: 's', quantity_on_hand: 1 })),
          error: null,
        };
      },
    });
    const ctx = makeServiceContext(stub.client, {
      permissions: new Set(['items:read']),
    });
    return { svc: new ExceptionsService(ctx), lists };
  }

  it('reads 250 reserved items in batches of at most 100 and flags one from the last batch', async () => {
    const { svc, lists } = svcFor({ reservedItems: ids(250) });
    const res = await svc.list();
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    // 250 over-reserved, rendered up to the per-rule cap and reported as truncated.
    expect(res.truncatedRules).toContain('over_reserved');
    expect(res.failedRules).toEqual([]);
  });

  it('a failed rule is named in failedRules and reported; the other rules still render', async () => {
    const { svc } = svcFor({ reservedItems: ids(3), failHoldings: true });
    const res = await svc.list();
    expect(res.failedRules).toEqual([
      'orphaned_stock',
      'stale_staging',
      'long_unplaced',
      'label_mismatch',
    ]);
    expect(res.exceptions.filter((e) => e.rule === 'over_reserved')).toHaveLength(3);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toEqual(['exceptions.rule_failed']);
  });

  it('a failed item batch fails only the over-reserved rule, never reads as "nothing over-reserved"', async () => {
    const { svc } = svcFor({ reservedItems: ids(250), failItemsBatch: 2 });
    const res = await svc.list();
    expect(res.failedRules).toEqual(['over_reserved']);
    expect(res.exceptions.filter((e) => e.rule === 'over_reserved')).toHaveLength(0);
  });
});
