import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { GET } from './route';

/**
 * SP-081b — a DELTA snapshot must be able to say what LEFT scope.
 *
 * The route only ever emitted rows that changed AND still matched its
 * filters, so an archived item or a deactivated bundle simply stopped
 * appearing. The mobile pull (apps/mobile/src/lib/sync.ts) upserts what it
 * receives and can only reconcile against a FULL pull, so the phone kept
 * serving archived items and deactivated kits for as long as the session
 * lasted. These tests pin the two additive fields the client already reads:
 * `removedItemIds` (delta only) and `activeBundleIds` (authoritative set).
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));

/** One recorded query: the table, the select string, and every filter call. */
interface Query {
  table: string;
  select: string;
  calls: Array<{ method: string; args: unknown[] }>;
}
type Responder = (q: Query) => { data: unknown; error: unknown };

const queries: Query[] = [];

/**
 * Chainable PostgREST-shaped stub. Every method returns the same object; the
 * chain resolves through `then`, at which point the responder decides what
 * this particular query gets back. Keyed on (table, select string) so the
 * route's THREE distinct inventory_items reads stay tellable apart.
 */
function makeClient(respond: Responder) {
  return {
    from(table: string) {
      const q: Query = { table, select: '', calls: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      const proxy = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) => {
              const { data, error } = respond(q);
              return Promise.resolve(resolve({ data, error }));
            };
          }
          return (...args: unknown[]) => {
            if (prop === 'select') q.select = String(args[0] ?? '');
            q.calls.push({ method: prop, args });
            return proxy;
          };
        },
      });
      return proxy as never;
    },
  };
}

/** True when this query carries an `.eq(col, value)` filter. */
const hasEq = (q: Query, col: string, value: unknown) =>
  q.calls.some((c) => c.method === 'eq' && c.args[0] === col && c.args[1] === value);

/** The `.range(from, to)` window a paged read asked for. */
const rangeOf = (q: Query) => q.calls.find((c) => c.method === 'range')?.args as
  | [number, number]
  | undefined;

interface World {
  /** Rows the in-scope items query returns (already filtered). */
  items: Array<{ id: string }>;
  /** Every non-bundle item row that changed since the cursor, in scope or not. */
  changedItemIds: string[];
  /** Bundles the (since-filtered) bundles query returns. */
  bundles: Array<{ id: string; name: string }>;
  /** The org's complete active-bundle id set. */
  activeBundleIds: string[];
  /** Force the id-only reads to fail, to prove they fail CLOSED. */
  failIdReads?: boolean;
}

function respondFor(world: World): Responder {
  const err = { message: 'boom', code: 'PGRST999' };
  return (q) => {
    if (q.table === 'warehouses') return { data: [{ id: 'wh1', name: 'Main' }], error: null };
    if (q.table === 'purchase_orders') return { data: [], error: null };
    if (q.table === 'cycle_counts') return { data: [], error: null };
    if (q.table === 'bundle_components') return { data: [], error: null };
    if (q.table === 'bundles') {
      // The id-only read is the removal read; the fat select is the payload.
      if (q.select.trim() === 'id') {
        if (world.failIdReads) return { data: null, error: err };
        const [from, to] = rangeOf(q) ?? [0, 999];
        return {
          data: world.activeBundleIds.slice(from, to + 1).map((id) => ({ id })),
          error: null,
        };
      }
      return { data: world.bundles, error: null };
    }
    if (q.table === 'inventory_items') {
      if (q.select.trim() === 'id') {
        if (world.failIdReads) return { data: null, error: err };
        const [from, to] = rangeOf(q) ?? [0, 999];
        return {
          data: world.changedItemIds.slice(from, to + 1).map((id) => ({ id })),
          error: null,
        };
      }
      // 'id, quantity_on_hand, warehouse_id' is the phantom lookup.
      if (q.select.includes('quantity_on_hand') && !q.select.includes('sku')) {
        return { data: [], error: null };
      }
      const [from, to] = rangeOf(q) ?? [0, 999];
      return {
        data: world.items.slice(from, to + 1).map((i) => ({
          ...i,
          sku: `sku-${i.id}`,
          name: i.id,
          barcode: null,
          quantity_on_hand: 1,
          unit_cost: 0,
          warehouse_id: 'wh1',
          item_type: 'standard',
          is_bundle: false,
          updated_at: '2026-09-05T12:00:00.000Z',
        })),
        error: null,
      };
    }
    return { data: [], error: null };
  };
}

async function callSnapshot(world: Partial<World>, qs = '') {
  const full: World = {
    items: [],
    changedItemIds: [],
    bundles: [],
    activeBundleIds: [],
    ...world,
  };
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    permissions: new Set(),
    enabledModules: new Set(),
    supabase: makeClient(respondFor(full)),
  } as never);
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/mobile/snapshot${qs}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const SINCE = '?since=2026-09-05T11:00:00.000Z';

beforeEach(() => {
  queries.length = 0;
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh1'],
    writableIds: ['wh1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh1',
  } as never);
});

describe('removedItemIds (delta pulls)', () => {
  it('reports an archived item — it changed but was not delivered', async () => {
    const body = await callSnapshot(
      { items: [{ id: 'i-keep' }], changedItemIds: ['i-keep', 'i-archived'] },
      SINCE,
    );
    expect(body.removedItemIds).toEqual(['i-archived']);
  });

  it('is empty, not absent, when everything that changed is still in scope', async () => {
    const body = await callSnapshot(
      { items: [{ id: 'i-keep' }], changedItemIds: ['i-keep'] },
      SINCE,
    );
    expect(body.removedItemIds).toEqual([]);
  });

  it('is NOT sent on a full pull — it would enumerate every item ever archived', async () => {
    const body = await callSnapshot({ items: [{ id: 'i-keep' }] });
    expect(body).not.toHaveProperty('removedItemIds');
    // and no id-only inventory_items read was issued at all
    expect(
      queries.filter((q) => q.table === 'inventory_items' && q.select.trim() === 'id'),
    ).toHaveLength(0);
  });

  it('excludes bundle phantom rows so a kit re-count is not shipped as a removal', async () => {
    await callSnapshot({ items: [], changedItemIds: [] }, SINCE);
    const idRead = queries.find(
      (q) => q.table === 'inventory_items' && q.select.trim() === 'id',
    );
    expect(idRead).toBeDefined();
    expect(hasEq(idRead!, 'is_bundle', false)).toBe(true);
    // and it is scoped to the cursor, not the whole table
    expect(idRead!.calls.some((c) => c.method === 'gte' && c.args[0] === 'updated_at')).toBe(
      true,
    );
  });

  it('OMITS the field when the read fails — never sends a list built from an error', async () => {
    const body = await callSnapshot(
      { items: [{ id: 'i-keep' }], changedItemIds: ['i-archived'], failIdReads: true },
      SINCE,
    );
    expect(body).not.toHaveProperty('removedItemIds');
    // the pull itself still succeeds; a removal read is not worth a 500
    expect(body).toHaveProperty('items');
  });
});

describe('activeBundleIds (authoritative set)', () => {
  it('sends the complete active set on a delta pull, beyond the since-filtered payload', async () => {
    const body = await callSnapshot(
      { bundles: [], activeBundleIds: ['b-live'] },
      SINCE,
    );
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual(['b-live']);
  });

  it('sends it on a full pull too', async () => {
    const body = await callSnapshot({ activeBundleIds: ['b-live', 'b-other'] });
    expect(body.activeBundleIds).toEqual(['b-live', 'b-other']);
  });

  it('pages past the PostgREST 1000-row cap — a truncated set would wipe live bundles', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `b-${String(i).padStart(4, '0')}`);
    const body = await callSnapshot({ activeBundleIds: many });
    expect(body.activeBundleIds).toHaveLength(1200);
    expect(
      queries.filter((q) => q.table === 'bundles' && q.select.trim() === 'id').length,
    ).toBeGreaterThan(1);
  });

  it('OMITS the field when the read fails, rather than sending [] and wiping the cache', async () => {
    const body = await callSnapshot({ activeBundleIds: ['b-live'], failIdReads: true }, SINCE);
    expect(body).not.toHaveProperty('activeBundleIds');
  });

  it('sends [] when the org genuinely has no active bundles', async () => {
    const body = await callSnapshot({ activeBundleIds: [] }, SINCE);
    expect(body.activeBundleIds).toEqual([]);
  });
});

describe('backward compatibility', () => {
  it('leaves every pre-existing field intact', async () => {
    const body = await callSnapshot(
      {
        items: [{ id: 'i-keep' }],
        changedItemIds: ['i-keep'],
        bundles: [{ id: 'b-live', name: 'Live kit' }],
        activeBundleIds: ['b-live'],
      },
      SINCE,
    );
    for (const key of [
      'serverTime',
      'since',
      'enabledModules',
      'permissions',
      'warehouseScope',
      'warehouses',
      'items',
      'openPOs',
      'openCycleCounts',
      'bundles',
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect((body.items as unknown[]).length).toBe(1);
    expect((body.bundles as Array<{ id: string }>)[0]?.id).toBe('b-live');
  });
});
