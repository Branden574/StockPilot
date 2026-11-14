import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { GET } from './route';

/**
 * The phone's sync sends open cycle counts, kits with their components, and
 * open purchase orders with their lines, only to members the web would show
 * them to:
 *
 *   - counts: the cycle counts module is on AND the member holds
 *     cycle_counts:read or stock:adjust (CycleCountsService.listPage, and the
 *     web count list and count pages);
 *   - kits: the bundles module is on AND the member holds bundles:read,
 *     bundles:distribute or bundles:manage (the web bundle list and bundle
 *     pages);
 *   - purchase orders: the purchase orders module is on AND the member holds
 *     purchase_orders:read (PurchaseOrdersService.get).
 *
 * Anyone else gets the same response shape with empty lists, and the reads
 * behind them are not sent. An empty `openCycleCounts` clears the phone's
 * clean cached counts on any pull, and an empty `activeBundleIds` clears its
 * cached kits on any pull (apps/mobile/src/lib/sync.ts).
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));

interface Query {
  table: string;
  select: string;
  calls: Array<{ method: string; args: unknown[] }>;
  sent: boolean;
}

const queries: Query[] = [];

const COUNT_ROW = {
  id: 'cc-1',
  count_number: 4,
  status: 'in_progress',
  warehouse_id: 'wh1',
  started_at: '2026-11-01T09:00:00.000Z',
  assigned_to: 'u-other',
  notes: null,
  lines: [{ id: 'ccl-1', item_id: 'i-1', expected_quantity: 12, counted_quantity: 9 }],
};

const COUNT_SENT = {
  id: 'cc-1',
  countNumber: 4,
  status: 'in_progress',
  warehouseId: 'wh1',
  startedAt: '2026-11-01T09:00:00.000Z',
  assignedTo: 'u-other',
  notes: null,
  lines: [{ id: 'ccl-1', itemId: 'i-1', expected: 12, counted: 9 }],
};

/** Two active kits: b-1 last changed before the test cursor, b-2 after it. */
const KIT_ROWS = [
  {
    id: 'b-1',
    name: 'Sample kit',
    sku: 'KIT-SAMPLE',
    preassembly_enabled: false,
    phantom_item_id: null,
    updated_at: '2026-11-01T07:00:00.000Z',
  },
  {
    id: 'b-2',
    name: 'Spare kit',
    sku: null,
    preassembly_enabled: false,
    phantom_item_id: null,
    updated_at: '2026-11-01T09:30:00.000Z',
  },
];

const KIT_SENT = {
  'b-1': {
    id: 'b-1',
    name: 'Sample kit',
    sku: 'KIT-SAMPLE',
    preassemblyEnabled: false,
    phantomItemId: null,
    phantomQty: 0,
    phantomWarehouseId: null,
    components: [{ itemId: 'i-1', quantity: 2, isOptional: false }],
  },
  'b-2': {
    id: 'b-2',
    name: 'Spare kit',
    sku: null,
    preassemblyEnabled: false,
    phantomItemId: null,
    phantomQty: 0,
    phantomWarehouseId: null,
    components: [],
  },
};

const PO_ROW = {
  id: 'po-1',
  po_number: 'PO-0100',
  status: 'ordered',
  expected_at: '2026-11-20',
  destination_location_id: 'loc-1',
  updated_at: '2026-11-01T09:00:00.000Z',
  destination: { warehouse_id: 'wh1' },
  items: [
    { id: 'pol-1', item_id: 'i-1', quantity_ordered: 10, quantity_received: 4, unit_cost: 3.25 },
  ],
};

const PO_SENT = {
  id: 'po-1',
  poNumber: 'PO-0100',
  status: 'ordered',
  expectedAt: '2026-11-20',
  warehouseId: 'wh1',
  lines: [{ id: 'pol-1', itemId: 'i-1', qtyOrdered: 10, qtyReceived: 4, unitCost: 3.25 }],
};

/** The `.gte('updated_at', x)` cursor a read carries, if any. */
const cursorOf = (q: Query) =>
  q.calls.find((c) => c.method === 'gte' && c.args[0] === 'updated_at')?.args[1] as
    | string
    | undefined;

function respond(q: Query): { data: unknown; error: unknown } {
  switch (q.table) {
    case 'warehouses':
      return { data: [{ id: 'wh1', name: 'Main' }], error: null };
    case 'purchase_orders':
      return { data: [PO_ROW], error: null };
    case 'cycle_counts':
      return { data: [COUNT_ROW], error: null };
    case 'bundles': {
      if (q.select.trim() === 'id') return { data: KIT_ROWS.map((k) => ({ id: k.id })), error: null };
      const since = cursorOf(q);
      return {
        data: since ? KIT_ROWS.filter((k) => k.updated_at >= since) : KIT_ROWS,
        error: null,
      };
    }
    case 'bundle_components': {
      const ids = (q.calls.find((c) => c.method === 'in')?.args[1] ?? []) as string[];
      return {
        data: ids.includes('b-1')
          ? [{ bundle_id: 'b-1', item_id: 'i-1', quantity: 2, is_optional: false }]
          : [],
        error: null,
      };
    }
    default:
      return { data: [], error: null };
  }
}

function makeClient() {
  return {
    from(table: string) {
      const q: Query = { table, select: '', calls: [], sent: false };
      queries.push(q);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) => {
                q.sent = true;
                return Promise.resolve(resolve(respond(q)));
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'select') q.select = String(args[0] ?? '');
              q.calls.push({ method: prop, args });
              return proxy;
            };
          },
        },
      );
      return proxy as never;
    },
  };
}

interface Caller {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  permissions: string[];
  modules: string[];
}

const VIEWER_DEFAULTS = [
  'members:read',
  'items:read',
  'locations:read',
  'categories:read',
  'suppliers:read',
  'purchase_orders:read',
  'orders:request',
  'maintenance_requests:submit',
];
const ALL_MODULES = ['inventory', 'cycle_counts', 'bundles', 'purchase_orders'];
const without = (list: string[], drop: string) => list.filter((v) => v !== drop);

async function pull(caller: Caller, qs = '') {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: caller.role,
    permissions: new Set(caller.permissions),
    enabledModules: new Set(caller.modules),
    supabase: makeClient(),
  } as never);
  const res = await GET(new NextRequest(`http://localhost/api/v1/mobile/snapshot${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const sent = (table: string) => queries.some((q) => q.table === table && q.sent);

const CURSOR = '2026-11-01T08:00:00.000Z';
const SINCE = `?since=${CURSOR}`;

beforeEach(() => {
  queries.length = 0;
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh1'],
    writableIds: ['wh1'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh1',
  } as never);
});

describe('open cycle counts follow the web count list rule', () => {
  it.each([
    ['a full pull', ''],
    ['a delta pull', SINCE],
  ])('a viewer gets an empty count list on %s, and the counts are not read', async (_l, qs) => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: ALL_MODULES }, qs);
    expect(body.openCycleCounts).toEqual([]);
    expect(sent('cycle_counts')).toBe(false);
  });

  it('a member holding cycle_counts:read gets nothing while the module is off', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'cycle_counts:read', 'stock:adjust'],
      modules: without(ALL_MODULES, 'cycle_counts'),
    });
    expect(body.openCycleCounts).toEqual([]);
    expect(sent('cycle_counts')).toBe(false);
  });

  it('a counter (cycle_counts:read) gets the open counts with their lines', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'cycle_counts:read'],
      modules: ALL_MODULES,
    });
    expect(body.openCycleCounts).toEqual([COUNT_SENT]);
  });

  it('stock:adjust alone also gets the open counts, as on the web', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'stock:adjust'],
      modules: ALL_MODULES,
    });
    expect(body.openCycleCounts).toEqual([COUNT_SENT]);
  });

  it('a read-only auditor (a viewer granted cycle_counts:read) gets the open counts', async () => {
    const body = await pull({
      role: 'viewer',
      permissions: [...VIEWER_DEFAULTS, 'cycle_counts:read'],
      modules: ALL_MODULES,
    });
    expect(body.openCycleCounts).toEqual([COUNT_SENT]);
  });
});

describe('kits follow the web bundle pages rule', () => {
  it.each([
    ['a full pull', ''],
    ['a delta pull', SINCE],
  ])('a viewer gets no kits and an empty active list on %s, and the kits are not read', async (_l, qs) => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: ALL_MODULES }, qs);
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual([]);
    expect(sent('bundles')).toBe(false);
    expect(sent('bundle_components')).toBe(false);
  });

  it('a member holding bundles:read gets no kits while the module is off', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'bundles:read', 'bundles:distribute'],
      modules: without(ALL_MODULES, 'bundles'),
    });
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual([]);
    expect(sent('bundles')).toBe(false);
  });

  it('a member holding only bundles:manage gets no kits while the module is off', async () => {
    const body = await pull({
      role: 'manager',
      permissions: ['items:read', 'bundles:manage'],
      modules: without(ALL_MODULES, 'bundles'),
    });
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual([]);
    expect(sent('bundles')).toBe(false);
  });

  it.each([['bundles:read'], ['bundles:distribute'], ['bundles:manage']])(
    'a member holding %s gets the kits with their components',
    async (perm) => {
      const body = await pull({ role: 'staff', permissions: ['items:read', perm], modules: ALL_MODULES });
      expect(body.bundles).toEqual([KIT_SENT['b-1'], KIT_SENT['b-2']]);
      expect(body.activeBundleIds).toEqual(['b-1', 'b-2']);
    },
  );

  it('a read-only auditor (a viewer granted bundles:read) gets the kits', async () => {
    const body = await pull({
      role: 'viewer',
      permissions: [...VIEWER_DEFAULTS, 'bundles:read'],
      modules: ALL_MODULES,
    });
    expect(body.bundles).toEqual([KIT_SENT['b-1'], KIT_SENT['b-2']]);
    expect(body.activeBundleIds).toEqual(['b-1', 'b-2']);
  });

  /**
   * The contract a phone relies on when kit access comes back: a pull while
   * the member may not read kits answers empty lists; the next allowed DELTA
   * pull names every active kit in activeBundleIds, while `bundles` still
   * carries only the kits changed since the cursor (the kits read stays
   * cursor-filtered). A phone that holds none of the named kits can tell from
   * the two lists that it needs a full pull.
   */
  it('a denied pull, then an allowed delta pull: every active kit is named, only changed kits are sent', async () => {
    const denied = await pull(
      { role: 'staff', permissions: ['items:read'], modules: ALL_MODULES },
      SINCE,
    );
    expect(denied.bundles).toEqual([]);
    expect(denied.activeBundleIds).toEqual([]);

    queries.length = 0;
    const allowed = await pull(
      { role: 'staff', permissions: ['items:read', 'bundles:read'], modules: ALL_MODULES },
      SINCE,
    );
    expect(allowed.activeBundleIds).toEqual(['b-1', 'b-2']);
    expect(allowed.bundles).toEqual([KIT_SENT['b-2']]);
    const kitsRead = queries.find((q) => q.table === 'bundles' && q.select.trim() !== 'id');
    expect(kitsRead && cursorOf(kitsRead)).toBe(CURSOR);
  });
});

describe('open purchase orders follow the web purchase order rule', () => {
  it.each([
    ['a full pull', ''],
    ['a delta pull', SINCE],
  ])(
    'a member without purchase_orders:read gets an empty list on %s, and the orders are not read',
    async (_l, qs) => {
      const body = await pull(
        {
          role: 'viewer',
          permissions: without(VIEWER_DEFAULTS, 'purchase_orders:read'),
          modules: ALL_MODULES,
        },
        qs,
      );
      expect(body.openPOs).toEqual([]);
      expect(sent('purchase_orders')).toBe(false);
    },
  );

  it('a member holding purchase_orders:read gets nothing while the module is off', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'purchase_orders:read', 'purchase_orders:manage'],
      modules: without(ALL_MODULES, 'purchase_orders'),
    });
    expect(body.openPOs).toEqual([]);
    expect(sent('purchase_orders')).toBe(false);
  });

  it('a viewer holding the default purchase_orders:read gets the open orders, costs included', async () => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: ALL_MODULES });
    expect(body.openPOs).toEqual([PO_SENT]);
  });
});

describe('the response keeps its shape for every member', () => {
  it('a member who may read none of the three gets the same keys, in the same order, as one who may read all', async () => {
    const none = await pull(
      { role: 'staff', permissions: ['items:read'], modules: ['inventory'] },
      SINCE,
    );
    queries.length = 0;
    const all = await pull(
      {
        role: 'staff',
        permissions: ['items:read', 'cycle_counts:read', 'bundles:read', 'purchase_orders:read'],
        modules: ALL_MODULES,
      },
      SINCE,
    );
    expect(Object.keys(none)).toEqual(Object.keys(all));
    expect(none.openPOs).toEqual([]);
    expect(none.openCycleCounts).toEqual([]);
    expect(none.bundles).toEqual([]);
    expect(none.activeBundleIds).toEqual([]);
  });

  it('the rest of a viewer pull is unchanged: warehouses are still read', async () => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: ALL_MODULES });
    expect(body.warehouses).toEqual([{ id: 'wh1', name: 'Main' }]);
    expect(sent('warehouses')).toBe(true);
  });
});
