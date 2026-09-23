import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * The Accounts page loads each customer's portal users and catalog, and each
 * price list's prices, up front. It used to make one request per customer
 * (twice) and one per price list, all started at once: with list()'s cap of 500
 * customers and listPriceLists()'s 200 lists, up to 1,200 PostgREST requests
 * for one page view, the one-request-per-row shape that drove 190 of 443
 * requests to 502 on the lab org. Each kind is now one batched read.
 *
 * Runs the real CustomersService against a stubbed client and counts requests.
 */

import {
  callArgs,
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('redirect');
  }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-test',
    userId: 'user-test',
    role: 'admin',
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => h.client) }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () =>
    makeServiceContext(h.client, {
      enabledModules: new Set<ModuleId>(['b2b_portal' as ModuleId]),
    }),
  ),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ list: async () => ({ items: [] }) })) },
}));
vi.mock('@/components/customers/customers-panel', () => ({ CustomersPanel: () => null }));
vi.mock('@/components/customers/portal-pricing-mode-panel', () => ({
  PortalPricingModePanel: () => null,
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({ ModuleNotEnabled: () => null }));

import { CustomersPanel } from '@/components/customers/customers-panel';

import CustomersPage from './page';

/** The props the page hands CustomersPanel, found in the returned tree. */
function panelProps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = panelProps(child);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === CustomersPanel) return el.props as Record<string, unknown>;
  return panelProps(el.props?.children);
}

const uuid = (i: number, p: string) =>
  `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const CUSTOMERS = Array.from({ length: 500 }, (_, i) => uuid(i, 'c'));
const LISTS = Array.from({ length: 200 }, (_, i) => uuid(i, 'b'));

function idsIn(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] as string[] | undefined) ?? [];
}
/** First page answers, later pages are empty (fetchAllRows paging). */
function firstPage(call: MockCall): boolean {
  const range = callArgs(call, 'range') as [number, number] | undefined;
  return !range || range[0] === 0;
}

function stub() {
  return makeSupabaseStub({
    'organizations.select': { data: { plan: 'business' }, error: null },
    'organization_modules.select': { data: { settings: {} }, error: null },
    'customers.select': {
      data: CUSTOMERS.map((id) => ({ id, name: id, status: 'active', created_at: '2026-09-01' })),
      error: null,
    },
    'price_lists.select': { data: LISTS.map((id) => ({ id, name: id })), error: null },
    // Two users per customer, returned newest invite first as ordered.
    'customer_users.select': (call) => ({
      data: firstPage(call)
        ? idsIn(call, 'customer_id').flatMap((cid) => [
            {
              customer_id: cid,
              user_id: `${cid}-u2`,
              email: 'b@x.test',
              invited_at: '2026-09-02',
              accepted_at: null,
            },
            {
              customer_id: cid,
              user_id: `${cid}-u1`,
              email: 'a@x.test',
              invited_at: '2026-09-01',
              accepted_at: null,
            },
          ])
        : [],
      error: null,
    }),
    'customer_catalog.select': (call) => ({
      data: firstPage(call)
        ? idsIn(call, 'customer_id').map((cid) => ({
            customer_id: cid,
            item_id: `${cid}-item`,
            item: { name: 'Item', sku: 'SKU' },
          }))
        : [],
      error: null,
    }),
    'price_list_items.select': (call) => ({
      data: firstPage(call)
        ? idsIn(call, 'price_list_id').map((pid) => ({
            price_list_id: pid,
            item_id: `${pid}-item`,
            unit_price: '12.5000',
            item: [{ name: 'Item', sku: 'SKU' }],
          }))
        : [],
      error: null,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Accounts page detail reads', () => {
  it('loads 500 customers and 200 price lists in a handful of batched requests, not 1,200', async () => {
    const s = stub();
    h.client = s.client;

    const tree = await CustomersPage();

    const requests = (key: string) => s.chainsAll.get(key)?.length ?? 0;
    // 100 ids per batch; each batch pages once more past its rows.
    expect(requests('customer_users.select')).toBeLessThanOrEqual(10);
    expect(requests('customer_catalog.select')).toBeLessThanOrEqual(10);
    expect(requests('price_list_items.select')).toBeLessThanOrEqual(4);
    // No request carries more than 100 ids.
    for (const key of ['customer_users.select', 'customer_catalog.select']) {
      for (const args of s.chainArgsAll.get(key) ?? []) {
        const inArg = args.find((a) => a[0] === 'customer_id');
        expect((inArg?.[1] as unknown[]).length).toBeLessThanOrEqual(100);
      }
    }

    const props = panelProps(tree) as unknown as {
      usersByCustomer: Record<string, Array<{ user_id: string }>>;
      catalogByCustomer: Record<string, Array<{ item_id: string; name: string | null }>>;
      pricesByList: Record<
        string,
        Array<{ item_id: string; unit_price: number; sku: string | null }>
      >;
    };
    expect(Object.keys(props.usersByCustomer)).toHaveLength(500);
    expect(props.usersByCustomer[CUSTOMERS[7]!]!.map((u) => u.user_id)).toEqual([
      `${CUSTOMERS[7]}-u2`,
      `${CUSTOMERS[7]}-u1`,
    ]);
    expect(props.catalogByCustomer[CUSTOMERS[499]!]).toEqual([
      { item_id: `${CUSTOMERS[499]}-item`, name: 'Item', sku: 'SKU' },
    ]);
    expect(props.pricesByList[LISTS[150]!]).toEqual([
      { item_id: `${LISTS[150]}-item`, unit_price: 12.5, name: 'Item', sku: 'SKU' },
    ]);
  });

  it('gives a customer with no users or catalog entries an empty list', async () => {
    const s = stub();
    const base = s.client.from;
    s.client.from = (table: string) =>
      table === 'customer_users' || table === 'customer_catalog'
        ? makeSupabaseStub({ [`${table}.select`]: { data: [], error: null } }).client.from(table)
        : base(table);
    h.client = s.client;

    const props = panelProps(await CustomersPage()) as unknown as {
      usersByCustomer: Record<string, unknown[]>;
      catalogByCustomer: Record<string, unknown[]>;
    };
    expect(props.usersByCustomer[CUSTOMERS[0]!]).toEqual([]);
    expect(props.catalogByCustomer[CUSTOMERS[0]!]).toEqual([]);
  });
});
