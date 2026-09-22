import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * InventoryService.get() asks its three questions TOGETHER.
 *
 * Production logs of the item page (2026-09-22) showed get() as three serial
 * Supabase levels: the item row, then the caller's warehouse access, then the
 * Staging/Unplaced holdings. Any call from Vercel can stall 1-8 s at the
 * gateway, so each level was another chance to stall the page. get() now
 * starts all three at once and decides from the row alone whether the other
 * two are used.
 *
 * What must NOT change, and is pinned here with the REAL warehouse helpers
 * (getWarehouseAccess / assertWarehouseAccess run against the call-recording
 * client below, not a mock that always says yes):
 *   - a row the caller's warehouse access does not cover is `not_found`, and
 *     nothing read alongside it is returned;
 *   - a missing or unreadable row is `not_found` / `internal_error`, and the
 *     reads abandoned with it can never surface as an unhandled rejection;
 *   - an access list that cannot be read DENIES (resolved error) or fails the
 *     call (thrown error). It is never read as "allowed".
 */

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('get() must use its own ctx, never requireOrgContext()');
  }),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { makeServiceContext } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { InventoryService } from './inventory';

type Answer = { data: unknown; error: { message: string } | null };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A client whose builders are LAZY like postgrest-js: a request "starts" only
 * when `.then` is called on the builder (maybeSingle() returns the builder, as
 * the real one does). So a read the code forgets to start early shows up here
 * as not started, exactly as it would in production.
 */
function makeRecordingClient(answers: Record<string, () => Promise<Answer>>) {
  const started: string[] = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (onFulfilled: (v: Answer) => unknown, onRejected?: (e: unknown) => unknown) => {
                started.push(table);
                const answer = answers[table];
                if (!answer) throw new Error(`unexpected read of ${table}`);
                return answer().then(onFulfilled, onRejected);
              };
            }
            return () => builder;
          },
        },
      );
      return builder;
    },
  };
  return { client, started };
}

const ROW = {
  id: 'item-1',
  organization_id: 'org-test',
  warehouse_id: 'wh-b',
  quantity_on_hand: 10,
  name: 'Widget',
};

const HOLDINGS: Answer = {
  data: [
    { quantity: 3, locations: { kind: 'staging' } },
    { quantity: 2, locations: { kind: 'unplaced' } },
  ],
  error: null,
};

function svcFor(client: unknown, role: 'owner' | 'manager' | 'staff' | 'viewer') {
  return new InventoryService(makeServiceContext(client, { role }) as never);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

describe('InventoryService.get: the row, the access list and the holdings are asked together', () => {
  it('starts the warehouse-access and holdings reads BEFORE the item row has answered', async () => {
    const row = deferred<Answer>();
    const { client, started } = makeRecordingClient({
      inventory_items: () => row.promise,
      item_stock_levels: async () => HOLDINGS,
      user_warehouse_assignments: async () => ({
        data: [{ warehouse_id: 'wh-b', is_primary: true }],
        error: null,
      }),
      organization_members: async () => ({ data: { all_warehouses: false }, error: null }),
    });

    const pending = svcFor(client, 'staff').get('item-1');
    await flush();

    // The row has not answered, and everything else is already on the wire.
    expect(started).toEqual(
      expect.arrayContaining([
        'inventory_items',
        'item_stock_levels',
        'user_warehouse_assignments',
        'organization_members',
      ]),
    );

    row.resolve({ data: { ...ROW }, error: null });
    const item = await pending;
    expect(item).toMatchObject({
      id: 'item-1',
      staged_quantity: 3,
      unplaced_quantity: 2,
      placed_quantity: 5,
    });
    // Each read happened once: parallel, not doubled.
    expect(started.filter((t) => t === 'user_warehouse_assignments')).toHaveLength(1);
    expect(started.filter((t) => t === 'item_stock_levels')).toHaveLength(1);
  });

  it('a row in a warehouse the caller is not assigned to is not_found, and the holdings read beside it are never returned', async () => {
    const { client } = makeRecordingClient({
      inventory_items: async () => ({ data: { ...ROW, warehouse_id: 'wh-b' }, error: null }),
      item_stock_levels: async () => HOLDINGS,
      user_warehouse_assignments: async () => ({
        data: [{ warehouse_id: 'wh-a', is_primary: true }],
        error: null,
      }),
      organization_members: async () => ({ data: { all_warehouses: false }, error: null }),
    });

    const err = await svcFor(client, 'staff').get('item-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('not_found');
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('an access list that answers with an ERROR denies (not_found), never reads as allowed', async () => {
    const { client } = makeRecordingClient({
      inventory_items: async () => ({ data: { ...ROW }, error: null }),
      item_stock_levels: async () => HOLDINGS,
      user_warehouse_assignments: async () => ({ data: null, error: { message: 'boom' } }),
      organization_members: async () => ({ data: null, error: { message: 'boom' } }),
    });

    const err = await svcFor(client, 'staff').get('item-1').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('not_found');
  });

  it('an access read that THROWS fails the call with that error (it is not swallowed into "allowed")', async () => {
    const boom = new Error('socket hang up');
    const { client } = makeRecordingClient({
      inventory_items: async () => ({ data: { ...ROW }, error: null }),
      item_stock_levels: async () => HOLDINGS,
      user_warehouse_assignments: async () => {
        throw boom;
      },
      organization_members: async () => ({ data: { all_warehouses: false }, error: null }),
    });

    await expect(svcFor(client, 'staff').get('item-1')).rejects.toBe(boom);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('a missing row is not_found, and the access + holdings reads it abandoned cannot become unhandled rejections', async () => {
    const { client, started } = makeRecordingClient({
      inventory_items: async () => ({ data: null, error: null }),
      item_stock_levels: async () => {
        throw new Error('holdings read failed');
      },
      user_warehouse_assignments: async () => {
        throw new Error('assignments read failed');
      },
      organization_members: async () => ({ data: null, error: null }),
    });

    const err = await svcFor(client, 'staff').get('item-1').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('not_found');
    // Give any unobserved rejection time to be reported.
    await flush();
    await flush();
    expect(started).toEqual(expect.arrayContaining(['item_stock_levels', 'user_warehouse_assignments']));
    expect(unhandled).toEqual([]);
  });

  it('an unreadable row is internal_error, with the same guarantee for the abandoned reads', async () => {
    const { client } = makeRecordingClient({
      inventory_items: async () => ({ data: null, error: { message: 'relation exploded' } }),
      item_stock_levels: async () => {
        throw new Error('holdings read failed');
      },
      warehouses: async () => {
        throw new Error('warehouses read failed');
      },
    });

    const err = await svcFor(client, 'manager').get('item-1').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('internal_error');
    await flush();
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('a manager is cleared by role, and the placement split is computed exactly as before', async () => {
    const { client } = makeRecordingClient({
      inventory_items: async () => ({ data: { ...ROW }, error: null }),
      item_stock_levels: async () => HOLDINGS,
      warehouses: async () => ({ data: [{ id: 'wh-a' }], error: null }),
    });

    const item = await svcFor(client, 'manager').get('item-1');
    expect(item).toMatchObject({ staged_quantity: 3, unplaced_quantity: 2, placed_quantity: 5 });
  });
});
