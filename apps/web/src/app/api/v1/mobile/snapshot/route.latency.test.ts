import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { checkRateLimit } from '@/lib/rate-limit';

import { GET } from './route';

/**
 * THE SNAPSHOT UNDER LATENCY (B25, the #242 follow-up "under the lab relay at
 * 1.5 s per Supabase call, the phone's /api/v1/mobile/snapshot exceeded its
 * 20 s client timeout").
 *
 * Every Supabase call below waits the same fixed time, as the lab relay
 * (scripts/perf-lab/lab/latency-relay.mjs, fixed mode) makes it, on a fake
 * clock, so the time the route takes is its chain of calls made one after
 * another, measured exactly:
 *
 *   - the token check and the request context (withApiContext: two calls, one
 *     after the other), then the rate limit (it keys on the verified user);
 *   - then every read at once (1e029ce5e), so the slowest of them: bundles then
 *     their components (two), or the ITEMS, which paged one 1,000-row page
 *     after another (fetchAllRows), one round trip per 1,000 items.
 *
 * At 1.5 s per call the items alone made a 12,000-item full pull 16 calls in a
 * row, 24 s, and the phone gave up at 20 s (apps/mobile/src/lib/api.ts
 * DEFAULT_TIMEOUT_MS). The pages after the first now go out together.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

/** The relay's fixed wait per call, and the phone's limit for the pull. */
const CALL_MS = 1_500;
const PHONE_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What one query is: which read, which page, whether it asked for the count. */
interface Query {
  table: string;
  select: string;
  count: boolean;
  range: [number, number];
}

let itemsTotal = 0;
let itemPagesInFlight = 0;
let maxItemPagesInFlight = 0;

function answer(q: Query): { data: unknown; error: null; count?: number } {
  const [from, to] = q.range;
  if (q.table === 'inventory_items' && q.select.includes('sku')) {
    const rows = [];
    for (let i = from; i <= to && i < itemsTotal; i += 1) {
      rows.push({
        id: `i-${String(i).padStart(6, '0')}`,
        sku: `SKU-${i}`,
        name: `Item ${i}`,
        barcode: null,
        quantity_on_hand: 1,
        unit_cost: 0,
        warehouse_id: 'wh1',
        item_type: 'standard',
        is_bundle: false,
        updated_at: '2026-10-01T00:00:00.000Z',
      });
    }
    return { data: rows, error: null, ...(q.count ? { count: itemsTotal } : {}) };
  }
  if (q.table === 'bundles' && q.select !== 'id') {
    return {
      data: [
        {
          id: 'b-1',
          name: 'Kit',
          sku: null,
          preassembly_enabled: false,
          phantom_item_id: null,
          updated_at: '2026-10-01T00:00:00.000Z',
        },
      ],
      error: null,
    };
  }
  if (q.table === 'bundles') return { data: [{ id: 'b-1' }], error: null };
  if (q.table === 'bundle_components') {
    return {
      data: [{ bundle_id: 'b-1', item_id: 'i-000001', quantity: 1, is_optional: false }],
      error: null,
    };
  }
  if (q.table === 'warehouses')
    return { data: [{ id: 'wh1', name: 'Main', updated_at: null }], error: null };
  return { data: [], error: null };
}

/** A PostgREST-shaped client: every awaited query costs CALL_MS. */
function slowClient() {
  return {
    from(table: string) {
      const q: Query = { table, select: '', count: false, range: [0, 999] };
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) => {
                const isItemPage = table === 'inventory_items' && q.select.includes('sku');
                if (isItemPage) {
                  itemPagesInFlight += 1;
                  maxItemPagesInFlight = Math.max(maxItemPagesInFlight, itemPagesInFlight);
                }
                return sleep(CALL_MS).then(() => {
                  if (isItemPage) itemPagesInFlight -= 1;
                  return resolve(answer(q));
                });
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'select') {
                q.select = String(args[0] ?? '')
                  .replace(/\s+/g, ' ')
                  .trim();
                q.count = (args[1] as { count?: string } | undefined)?.count === 'exact';
              }
              if (prop === 'range') q.range = args as [number, number];
              return proxy;
            };
          },
        },
      );
      return proxy as never;
    },
  };
}

/** The route's answer, and how long it took on the fake clock. */
async function timedPull(): Promise<{ status: number; ms: number; items: number }> {
  const started = Date.now();
  let finished: number | null = null;
  const res = GET(new NextRequest('http://localhost/api/v1/mobile/snapshot')).then((r) => {
    finished = Date.now();
    return r;
  });
  while (finished === null) await vi.advanceTimersByTimeAsync(50);
  const r = await res;
  const body = (await r.json()) as { items: unknown[] };
  return { status: r.status, ms: (finished as number) - started, items: body.items.length };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  itemPagesInFlight = 0;
  maxItemPagesInFlight = 0;
  // withApiContext: the token check, then the request context.
  vi.mocked(withApiContext).mockImplementation(async () => {
    await sleep(2 * CALL_MS);
    return {
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'manager',
      permissions: new Set(),
      enabledModules: new Set(['inventory']),
      mfaRequired: false,
      mfaSatisfied: true,
      mfaEnrolled: false,
      supabase: slowClient(),
    } as never;
  });
  vi.mocked(checkRateLimit).mockImplementation(async () => {
    await sleep(CALL_MS);
    return { allowed: true, count: 1, resetAt: Date.now() + 60_000 };
  });
  vi.mocked(getWarehouseAccess).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the snapshot at 1.5 s per Supabase call', () => {
  it("a 12,000-item full pull answers inside the phone's 20 s (it took 24 s)", async () => {
    itemsTotal = 12_000;
    const pull = await timedPull();
    expect(pull.status).toBe(200);
    expect(pull.items).toBe(12_000);
    // Two calls for the context, the limit, then the items: the first page,
    // the eleven it counts in two waves of six, and the page after the last
    // full one. One page at a time this was 3 + 13 calls.
    expect(pull.ms).toBe(7 * CALL_MS);
    expect(pull.ms).toBeLessThan(PHONE_TIMEOUT_MS);
    expect(maxItemPagesInFlight).toBe(6);
  });

  it('the time no longer grows a call per 1,000 items', async () => {
    itemsTotal = 3_500;
    const small = await timedPull();
    itemsTotal = 9_500;
    const large = await timedPull();
    // 3,500: the first page and three more at once. 9,500: the first page and
    // nine more in two waves. One page at a time: 3 + 4 calls, and 3 + 10.
    expect(small.ms).toBe(5 * CALL_MS);
    expect(large.ms).toBe(6 * CALL_MS);
  });

  it('a small organization costs the context, the limit and bundles then components (unchanged)', async () => {
    itemsTotal = 443;
    const pull = await timedPull();
    expect(pull.items).toBe(443);
    expect(pull.ms).toBe(5 * CALL_MS);
  });
});
