import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The evaluator batches its reserved-item read (every item with an open
 * reservation, org-wide, has no ceiling) and settles each rule group on its
 * own, so one failed read names its rules in `failedRules` — which keeps them
 * out of `completeRules`, so the sync resolves nothing of theirs — instead of
 * reading as "nothing wrong".
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { ExceptionsService } from './exceptions';
import { buildSystemContext } from './lib/system-context';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, p?: string) => Array.from({ length: n }, (_, i) => uuid(i, p));

function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}

beforeEach(() => {
  reportError.mockClear();
});

describe('evaluateForSync with many reserved items', () => {
  async function evaluateWith(opts: {
    reservedItems: string[];
    failItemsBatch?: number;
    failHoldings?: boolean;
  }) {
    let itemCalls = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: [{ user_id: 'u-owner', role: 'owner' }], error: null },
      'organization_modules.select': { data: [], error: null },
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
          data: list.map((id) => ({ id, name: id, sku: 's', warehouse_id: null, quantity_on_hand: 1 })),
          error: null,
        };
      },
    });
    const ctx = await buildSystemContext(stub.client, 'org-test');
    const res = await ExceptionsService.evaluateForSync(ctx!);
    return { res, lists };
  }

  it('reads 250 reserved items in batches of at most 100 and emits all 250', async () => {
    const { res, lists } = await evaluateWith({ reservedItems: ids(250) });
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    // Uncapped: every over-reserved item is present, none truncated.
    expect(res.present.filter((p) => p.rule === 'over_reserved')).toHaveLength(250);
    expect(res.truncatedRules).toEqual([]);
    expect(res.failedRules).toEqual([]);
    expect(res.completeRules).toContain('over_reserved');
  });

  it('a failed rule group is named in failedRules and reported; the other rules still count', async () => {
    const { res } = await evaluateWith({ reservedItems: ids(3), failHoldings: true });
    expect(res.failedRules).toEqual([
      'orphaned_stock',
      'stale_staging',
      'long_unplaced',
      'label_mismatch',
    ]);
    expect(res.completeRules).toEqual(['over_reserved', 'count_variance']);
    expect(res.present.filter((p) => p.rule === 'over_reserved')).toHaveLength(3);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toEqual(['exceptions.rule_failed']);
  });

  it('a failed item batch fails only the over-reserved rule, never reads as "nothing over-reserved"', async () => {
    const { res } = await evaluateWith({ reservedItems: ids(250), failItemsBatch: 2 });
    expect(res.failedRules).toEqual(['over_reserved']);
    expect(res.completeRules).not.toContain('over_reserved');
    expect(res.present.filter((p) => p.rule === 'over_reserved')).toHaveLength(0);
  });
});
