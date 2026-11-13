import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { GET } from './route';

/**
 * The phone's sync sends open cycle counts, and kits with their components,
 * only to members the web would show them to:
 *
 *   - counts: the cycle counts module is on AND the member holds
 *     cycle_counts:read or stock:adjust (CycleCountsService.listPage, and the
 *     web count list and count pages);
 *   - kits: the bundles module is on AND the member holds bundles:read,
 *     bundles:distribute or bundles:manage (the web bundle list and bundle
 *     pages).
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

const KIT_ROW = {
  id: 'b-1',
  name: 'Sample kit',
  sku: 'KIT-SAMPLE',
  preassembly_enabled: false,
  phantom_item_id: null,
  updated_at: '2026-11-01T09:00:00.000Z',
};

function respond(q: Query): { data: unknown; error: unknown } {
  switch (q.table) {
    case 'warehouses':
      return { data: [{ id: 'wh1', name: 'Main' }], error: null };
    case 'cycle_counts':
      return { data: [COUNT_ROW], error: null };
    case 'bundles':
      return q.select.trim() === 'id'
        ? { data: [{ id: 'b-1' }], error: null }
        : { data: [KIT_ROW], error: null };
    case 'bundle_components':
      return {
        data: [{ bundle_id: 'b-1', item_id: 'i-1', quantity: 2, is_optional: false }],
        error: null,
      };
    default:
      return { data: [], error: null };
  }
}

function makeClient() {
  return {
    from(table: string) {
      const q: Query = { table, select: '', sent: false };
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
const BOTH_MODULES = ['inventory', 'cycle_counts', 'bundles'];

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

const SINCE = '?since=2026-11-01T08:00:00.000Z';

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
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: BOTH_MODULES }, qs);
    expect(body.openCycleCounts).toEqual([]);
    expect(sent('cycle_counts')).toBe(false);
  });

  it('a member holding cycle_counts:read gets nothing while the module is off', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'cycle_counts:read', 'stock:adjust'],
      modules: ['inventory', 'bundles'],
    });
    expect(body.openCycleCounts).toEqual([]);
    expect(sent('cycle_counts')).toBe(false);
  });

  it('a counter (cycle_counts:read) gets the open counts with their lines', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'cycle_counts:read'],
      modules: BOTH_MODULES,
    });
    expect(body.openCycleCounts).toEqual([
      {
        id: 'cc-1',
        countNumber: 4,
        status: 'in_progress',
        warehouseId: 'wh1',
        startedAt: '2026-11-01T09:00:00.000Z',
        assignedTo: 'u-other',
        notes: null,
        lines: [{ id: 'ccl-1', itemId: 'i-1', expected: 12, counted: 9 }],
      },
    ]);
  });

  it('stock:adjust alone also gets the open counts, as on the web', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'stock:adjust'],
      modules: BOTH_MODULES,
    });
    expect((body.openCycleCounts as unknown[]).length).toBe(1);
  });
});

describe('kits follow the web bundle pages rule', () => {
  it.each([
    ['a full pull', ''],
    ['a delta pull', SINCE],
  ])('a viewer gets no kits and an empty active list on %s, and the kits are not read', async (_l, qs) => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: BOTH_MODULES }, qs);
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual([]);
    expect(sent('bundles')).toBe(false);
    expect(sent('bundle_components')).toBe(false);
  });

  it('a member holding bundles:read gets no kits while the module is off', async () => {
    const body = await pull({
      role: 'staff',
      permissions: ['items:read', 'bundles:read', 'bundles:distribute'],
      modules: ['inventory', 'cycle_counts'],
    });
    expect(body.bundles).toEqual([]);
    expect(body.activeBundleIds).toEqual([]);
    expect(sent('bundles')).toBe(false);
  });

  it.each([['bundles:read'], ['bundles:distribute'], ['bundles:manage']])(
    'a member holding %s gets the kits with their components',
    async (perm) => {
      const body = await pull({ role: 'staff', permissions: ['items:read', perm], modules: BOTH_MODULES });
      expect(body.bundles).toEqual([
        {
          id: 'b-1',
          name: 'Sample kit',
          sku: 'KIT-SAMPLE',
          preassemblyEnabled: false,
          phantomItemId: null,
          phantomQty: 0,
          phantomWarehouseId: null,
          components: [{ itemId: 'i-1', quantity: 2, isOptional: false }],
        },
      ]);
      expect(body.activeBundleIds).toEqual(['b-1']);
    },
  );
});

describe('the response keeps its shape for every member', () => {
  it('a viewer gets the same keys, in the same order, as a counter', async () => {
    const viewer = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: BOTH_MODULES }, SINCE);
    queries.length = 0;
    const counter = await pull(
      {
        role: 'staff',
        permissions: ['items:read', 'cycle_counts:read', 'bundles:read'],
        modules: BOTH_MODULES,
      },
      SINCE,
    );
    expect(Object.keys(viewer)).toEqual(Object.keys(counter));
    expect(Array.isArray(viewer.openCycleCounts)).toBe(true);
    expect(Array.isArray(viewer.bundles)).toBe(true);
  });

  it('the rest of a viewer pull is unchanged: warehouses are still read', async () => {
    const body = await pull({ role: 'viewer', permissions: VIEWER_DEFAULTS, modules: BOTH_MODULES });
    expect(body.warehouses).toEqual([{ id: 'wh1', name: 'Main' }]);
    expect(sent('warehouses')).toBe(true);
  });
});
