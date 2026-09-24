import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sync for an org with many bundles.
 *
 * An org's active bundles are not capped. The bundle components and phantom
 * reads each sent every bundle id in one `.in()`: past ~215 ids the local
 * gateway answers 414 and past ~395 production fails after ~7 s of retries,
 * and either failure was the whole snapshot's 500, so the phone stopped
 * syncing. The components read was also unpaged (cut at 1000 rows). Both now
 * go 100 ids per request, paged. The fix is in this web route, so no phone
 * release is needed.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { GET } from './route';

const bundleId = (i: number) => `00000000-0000-4000-8000-b${String(i).padStart(11, '0')}`;
const phantomId = (i: number) => `00000000-0000-4000-8000-f${String(i).padStart(11, '0')}`;
const N = 250;
const bundles = Array.from({ length: N }, (_, i) => ({
  id: bundleId(i),
  name: `Kit ${String(i).padStart(3, '0')}`,
  sku: null,
  preassembly_enabled: true,
  phantom_item_id: phantomId(i),
  updated_at: '2026-09-22T00:00:00Z',
}));

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
function rangeOf(call: MockCall): [number, number] {
  return call.args[call.methods.indexOf('range')] as [number, number];
}

/** The `.is()` filters on a recorded read, to apply like PostgREST would. */
function isFilters(call: MockCall): Array<[string, unknown]> {
  return call.methods
    .map((m, i) => (m === 'is' ? (call.args[i] as [string, unknown]) : null))
    .filter((f): f is [string, unknown] => f != null);
}

function stubWith(opts: { failComponentBatch?: number; deletedPhantoms?: Set<string> } = {}) {
  const componentLists: string[][] = [];
  const phantomLists: string[][] = [];
  const stub = makeSupabaseStub({
    'warehouses.select': { data: [], error: null },
    'purchase_orders.select': { data: [], error: null },
    'cycle_counts.select': { data: [], error: null },
    'bundles.select': (call) =>
      call.methods.includes('range')
        ? { data: bundles.slice(rangeOf(call)[0], rangeOf(call)[1] + 1).map((b) => ({ id: b.id })), error: null }
        : { data: bundles, error: null },
    'bundle_components.select': (call) => {
      const ids = inList(call, 'bundle_id');
      if (rangeOf(call)[0] === 0) componentLists.push(ids);
      if (componentLists.length === opts.failComponentBatch) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      // 12 components per bundle: 1200 rows for a batch of 100, two pages.
      const all = ids.flatMap((bundle_id) =>
        Array.from({ length: 12 }, (_, k) => ({
          bundle_id,
          item_id: `item-${k}`,
          quantity: 1,
          is_optional: false,
        })),
      );
      const [from, to] = rangeOf(call);
      return { data: all.slice(from, to + 1), error: null };
    },
    'inventory_items.select': (call) => {
      const ids = inList(call, 'id');
      if (ids.length > 0) {
        phantomLists.push(ids);
        const rows = ids.map((id) => ({
          id,
          quantity_on_hand: 3,
          warehouse_id: 'wh-1',
          deleted_at: opts.deletedPhantoms?.has(id) ? '2026-09-20T00:00:00Z' : null,
        }));
        const kept = rows.filter((r) =>
          isFilters(call).every(([col, val]) => (r as Record<string, unknown>)[col] === val),
        );
        return {
          data: kept.map(({ id, quantity_on_hand, warehouse_id }) => ({
            id,
            quantity_on_hand,
            warehouse_id,
          })),
          error: null,
        };
      }
      return { data: [], error: null };
    },
  });
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
    supabase: stub.client,
    enabledModules: new Set(['bundles']),
    permissions: new Set<string>(),
  } as never);
  return { componentLists, phantomLists };
}

beforeEach(() => vi.clearAllMocks());

describe('mobile snapshot with 250 bundles', () => {
  it('reads components and phantoms 100 bundles at a time, pages the components, and ships every kit whole', async () => {
    const { componentLists, phantomLists } = stubWith();
    const res = await GET(new NextRequest('https://test.local/api/v1/mobile/snapshot'));
    expect(res.status).toBe(200);
    expect(componentLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(phantomLists.map((l) => l.length)).toEqual([100, 100, 50]);

    const body = (await res.json()) as {
      bundles: Array<{ id: string; components: unknown[]; phantomQty: number }>;
    };
    expect(body.bundles).toHaveLength(N);
    // Every bundle has all 12 components, including past a batch's first
    // 1000-row page and in the last batch.
    expect(body.bundles.every((b) => b.components.length === 12)).toBe(true);
    expect(body.bundles.find((b) => b.id === bundleId(249))?.phantomQty).toBe(3);
  });

  it("ships a deleted kit item's bundle with phantomQty 0, so its stock never reaches the phone", async () => {
    // distribute_bundle (0365) reads a deleted kit item as 0 and assemble
    // refuses it; the phone's cache must not offer those kits.
    stubWith({ deletedPhantoms: new Set([phantomId(7)]) });
    const res = await GET(new NextRequest('https://test.local/api/v1/mobile/snapshot'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundles: Array<{ id: string; phantomQty: number; phantomWarehouseId: string | null }>;
    };
    expect(body.bundles.find((b) => b.id === bundleId(7))).toMatchObject({
      phantomQty: 0,
      phantomWarehouseId: null,
    });
    // The bundle itself still ships; a live kit item next to it is unchanged.
    expect(body.bundles.find((b) => b.id === bundleId(8))).toMatchObject({
      phantomQty: 3,
      phantomWarehouseId: 'wh-1',
    });
  });

  it('a failed component batch is the bundle_components 500, as before (the phone keeps its cache)', async () => {
    stubWith({ failComponentBatch: 2 });
    const res = await GET(new NextRequest('https://test.local/api/v1/mobile/snapshot'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal_error', query: 'bundle_components' });
  });
});
