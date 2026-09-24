import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * buildOrgSnapshot's "Items needing attention (low or out)" count, which the
 * assistant quotes for "how are we doing". A kit's pre-assembled stock (the
 * hidden is_bundle item assemble_bundle keeps kits in) runs out as a matter
 * of course: distribute draws it first, then the components. Counted, every
 * fully distributed kit became an item "needing attention" that no reorder
 * can fix (kits are never ordered, 0366).
 */

vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
// tools.ts pulls in the whole service layer; none of it is exercised here.
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-2.0-flash',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));

import { buildOrgSnapshot } from './chat';

describe('buildOrgSnapshot — low-or-out count', () => {
  it('leaves a kit\'s pre-assembled stock out of "Items needing attention"', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: null, count: 3 } as never,
      'stock_movements.select': { data: null, error: null, count: 0 } as never,
    });

    await buildOrgSnapshot(makeServiceContext(stub.client) as never);

    // Two inventory_items counts: active items, then low-or-out. The second
    // is the one the kit filter belongs to (the stub cannot evaluate .or()).
    const chains = stub.chainsAll.get('inventory_items.select') ?? [];
    const argsAll = stub.chainArgsAll.get('inventory_items.select') ?? [];
    const lowIdx = chains.findIndex((c) => c.includes('or'));
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    const low = chains[lowIdx] ?? [];
    const lowArgs = argsAll[lowIdx] ?? [];
    const eqs = low.map((m, i) => ({ m, a: lowArgs[i] })).filter((c) => c.m === 'eq').map((c) => c.a);
    expect(eqs).toContainEqual(['is_bundle', false]);
    expect(lowArgs[low.indexOf('or')]).toEqual(['reorder_point.gt.0,quantity_on_hand.lte.0']);
  });
});
