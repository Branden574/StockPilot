import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DEFAULT_MODULE_IDS, ORDER_CATALOG_ROW_CEILING, type Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Security invariant: the phone storefront's reads are Bearer-safe (phone
 * ordering PO-3, plan 3.8, risk 3; recurring bug pattern #23).
 *
 * A phone request carries `Authorization: Bearer`, not a cookie session, so
 * the cookie client (`@/lib/supabase/server` createClient) is ANONYMOUS there.
 * Any read left on it answers as nobody, without an error: a staff member or
 * viewer got an empty warehouse list, an empty catalog (the scope helpers saw
 * no auth.uid()), no kits and no Frequently ordered. A test driven as a
 * manager passes with that bug in place, because owner, admin and manager
 * skip the scope read altogether.
 *
 * So this drives the three REAL routes through the REAL service and loaders,
 * as an L4L-shaped VIEWER (category grants plus a charter-scoped warehouse
 * assignment), with the cookie client and the request-cached module read made
 * to THROW, and checks that every scope helper went to the caller's own client
 * (ctx.supabase) and that the answer is exactly the viewer's rows. The shared
 * cached reads (catalog rows, sites, photos) run on a fake admin client that
 * EVALUATES the filters the loaders send.
 */

const { cookieClientMock, modulesForRequestMock, adminState } = vi.hoisted(() => ({
  cookieClientMock: vi.fn(() => {
    throw new Error('the cookie client was used on a Bearer request');
  }),
  modulesForRequestMock: vi.fn(() => {
    throw new Error('the request-cached module read was used on a Bearer request');
  }),
  adminState: { client: null as unknown },
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: cookieClientMock }));
vi.mock('@/lib/dashboard/request-cache', () => ({ getModulesForRequest: modulesForRequestMock }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminState.client }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { withApiContext } from '@/lib/auth/api-context';
import { CATALOG_ROW_CEILING, loadCatalogBundle } from '@/server/loaders/orders-new-catalog';

import { GET as GET_CATALOG } from '../catalog/route';
import { GET as GET_PHOTOS } from '../catalog/photos/route';
import { GET as GET_STOREFRONT } from './route';

const ORG = '00000000-0000-4000-8000-00000000000a';
const VIEWER = '00000000-0000-4000-8000-0000000000aa';
const WH = '00000000-0000-4000-8000-0000000000b1';
const WH_OTHER = '00000000-0000-4000-8000-0000000000b2';
const CHARTER_MINE = '00000000-0000-4000-8000-0000000000c1';
const CHARTER_OTHER = '00000000-0000-4000-8000-0000000000c2';
const CAT_GRANTED = '00000000-0000-4000-8000-0000000000d1';
const CAT_GRANTED_2 = '00000000-0000-4000-8000-0000000000d2';
const CAT_NOT = '00000000-0000-4000-8000-0000000000d3';
const BUNDLE = '00000000-0000-4000-8000-0000000000e1';
const id = (n: number) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;

/** DC4-like rows: generic and charter-earmarked stock across granted and
 *  ungranted categories, plus rows the catalog never shows. */
type ItemRow = Record<string, unknown> & { id: string };
const ITEMS: ItemRow[] = [];
const VISIBLE: string[] = [];
for (let n = 0; n < 60; n += 1) {
  const category = [CAT_GRANTED, CAT_GRANTED_2, CAT_NOT, null][n % 4]!;
  const charter = [null, null, CHARTER_MINE, CHARTER_OTHER][Math.floor(n / 4) % 4]!;
  const row: ItemRow = {
    id: id(n),
    organization_id: ORG,
    warehouse_id: WH,
    name: `Item ${String(n).padStart(2, '0')}`,
    sku: `SKU-${n}`,
    quantity_on_hand: 10 + n,
    item_type: 'product',
    bin_location: `${n}-A`,
    category_id: category,
    charter_id: charter,
    retail_price: 99.99,
    unit_cost: 55.55,
    reorder_point: 1,
    rack_number: null,
    rack_row: null,
    book_rack_number: null,
    book_rack_row: null,
    status: 'active',
    is_rental: false,
    awaiting_first_receipt: false,
    deleted_at: null,
    is_bundle: null,
  };
  ITEMS.push(row);
  const granted = category === CAT_GRANTED || category === CAT_GRANTED_2;
  const charterOk = charter === null || charter === CHARTER_MINE;
  if (granted && charterOk) VISIBLE.push(row.id);
}
// Rows no catalog shows: another warehouse, a rental, a deleted item.
ITEMS.push({ ...ITEMS[0]!, id: id(900), warehouse_id: WH_OTHER });
ITEMS.push({ ...ITEMS[0]!, id: id(901), is_rental: true });
ITEMS.push({ ...ITEMS[0]!, id: id(902), deleted_at: '2026-09-01T00:00:00Z' });
const ALL_ORDERABLE = ITEMS.filter(
  (r) => r.warehouse_id === WH && !r.is_rental && r.deleted_at === null,
).map((r) => r.id);

const CATEGORIES = [
  { id: CAT_GRANTED, organization_id: ORG, name: 'Supplies' },
  { id: CAT_GRANTED_2, organization_id: ORG, name: 'Apparel' },
  { id: CAT_NOT, organization_id: ORG, name: 'Hidden' },
];
const CHARTERS = [
  { id: CHARTER_MINE, organization_id: ORG, name: 'North', code: 'N' },
  { id: CHARTER_OTHER, organization_id: ORG, name: 'South', code: 'S' },
];
const IMAGES = ITEMS.map((r, i) => ({
  id: `img-${i}`,
  organization_id: ORG,
  item_id: r.id,
  'item.warehouse_id': r.warehouse_id,
  'item.deleted_at': r.deleted_at,
  thumb_path: i % 3 === 0 ? null : `${ORG}/items/${r.id}/thumb.webp`,
  storage_path: `${ORG}/items/${r.id}/master.webp`,
  lqip: null,
  is_primary: true,
  sort_order: 0,
}));

/** Evaluates the filters a loader sent against `rows` (eq, neq, is, in, or
 *  groups, order, range), as PostgREST would, capped at 1000 rows. */
function evaluating(rows: ReadonlyArray<Record<string, unknown>>) {
  const term = (row: Record<string, unknown>, t: string): boolean => {
    const [col, op, ...rest] = t.split('.');
    const value = rest.join('.');
    if (op === 'is' && value === 'null') return row[col!] === null;
    if (op === 'eq') return String(row[col!]) === value;
    if (op === 'in') return value.slice(1, -1).split(',').includes(row[col!] as string);
    throw new Error(`fake: unsupported or-term ${t}`);
  };
  const split = (expr: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of expr) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  return (call: { methods: string[]; args: unknown[][] }) => {
    let out = [...rows];
    let range: [number, number] = [0, 999];
    const orderBy: string[] = [];
    call.methods.forEach((m, i) => {
      const a = call.args[i] ?? [];
      if (m === 'eq') out = out.filter((r) => r[a[0] as string] === a[1]);
      else if (m === 'neq') out = out.filter((r) => r[a[0] as string] !== a[1]);
      else if (m === 'is') out = out.filter((r) => r[a[0] as string] === a[1]);
      else if (m === 'in') out = out.filter((r) => (a[1] as unknown[]).includes(r[a[0] as string]));
      else if (m === 'or') out = out.filter((r) => split(a[0] as string).some((x) => term(r, x)));
      else if (m === 'order') orderBy.push(a[0] as string);
      else if (m === 'range') range = [a[0] as number, a[1] as number];
      else if (m !== 'select') throw new Error(`fake: unsupported ${m}`);
    });
    out.sort((x, y) => {
      for (const col of orderBy) {
        const p = String(x[col]);
        const q = String(y[col]);
        if (p !== q) return p < q ? -1 : 1;
      }
      return 0;
    });
    return { data: out.slice(range[0], range[1] + 1).slice(0, 1000), error: null };
  };
}

function adminClient() {
  const stub = makeSupabaseStub({
    'inventory_items.select': evaluating(ITEMS),
    'stock_reservations.select': { data: [], error: null },
    'categories.select': evaluating(CATEGORIES),
    'charters.select': evaluating(CHARTERS),
    'item_images.select': evaluating(IMAGES),
    'warehouse_charters.select': {
      data: [
        { charter: { id: CHARTER_MINE, name: 'North', code: 'N', status: 'active', address: null } },
      ],
      error: null,
    },
  });
  const createSignedUrls = vi.fn(async (paths: string[]) => ({
    data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })),
    error: null,
  }));
  (stub.client.storage as unknown as { from: unknown }).from = vi.fn(() => ({ createSignedUrls }));
  return stub;
}

/** The caller's own client: what their token's row level security answers. */
function callerClient(role: Role) {
  return makeSupabaseStub({
    'warehouses.select': servedLikePostgrest([
      { id: WH, name: 'DC4', organization_id: ORG, status: 'active' },
    ]),
    'user_profiles.select': { data: { full_name: 'Pat', email: 'pat@example.org' }, error: null },
    'organizations.select': { data: { timezone: 'America/Los_Angeles', email_routing: null }, error: null },
    // The five scope helpers, as 0229/0310 answer for this viewer.
    'rpc:rls_inv_read_full_warehouse_ids': { data: role === 'viewer' ? [] : [WH], error: null },
    'rpc:rls_inv_read_assigned_warehouse_ids': { data: [WH], error: null },
    'rpc:rls_inv_read_warehouse_charter_ids': {
      data: [{ warehouse_id: WH, charter_id: CHARTER_MINE }],
      error: null,
    },
    'rpc:rls_cat_unrestricted_org_ids': { data: role === 'viewer' ? [] : [ORG], error: null },
    'rpc:rls_cat_allowed_category_ids': {
      data:
        role === 'viewer'
          ? [
              { organization_id: ORG, category_id: CAT_GRANTED },
              { organization_id: ORG, category_id: CAT_GRANTED_2 },
            ]
          : [],
      error: null,
    },
    // Frequently ordered counts every member's orders here; one of the top
    // items is outside this viewer's catalog and must not be named.
    'rpc:order_request_top_skus_for_warehouse': {
      data: [
        { item_id: VISIBLE[0], request_count: 9 },
        { item_id: id(2), request_count: 8 }, // CAT_NOT
        { item_id: VISIBLE[1], request_count: 3 },
      ],
      error: null,
    },
    // A kit whose components are both visible to the viewer.
    'bundles.select': {
      data: [
        {
          id: BUNDLE,
          name: 'Starter Kit',
          sku: 'KIT-1',
          bundle_components: [VISIBLE[0], VISIBLE[1]].map((itemId) => {
            const row = ITEMS.find((r) => r.id === itemId)!;
            return {
              item_id: itemId,
              quantity: 1,
              is_optional: false,
              item: { id: itemId, sku: row.sku, warehouse_id: WH, charter_id: row.charter_id, deleted_at: null },
            };
          }),
        },
      ],
      error: null,
    },
  });
}

const SCOPE_HELPERS = [
  'rls_cat_allowed_category_ids',
  'rls_cat_unrestricted_org_ids',
  'rls_inv_read_assigned_warehouse_ids',
  'rls_inv_read_full_warehouse_ids',
  'rls_inv_read_warehouse_charter_ids',
];

function asCaller(role: Role) {
  const caller = callerClient(role);
  const ctx = makeServiceContext(caller.client, {
    organizationId: ORG,
    userId: VIEWER,
    role,
    // withApiContext always sets the effective set; orders:request is on by
    // default for every role.
    permissions: new Set(['orders:request', ...(role === 'viewer' ? [] : ['orders:approve'])]),
    enabledModules: new Set(DEFAULT_MODULE_IDS),
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return caller;
}

const get = async (
  route: (req: NextRequest) => Promise<Response>,
  url: string,
): Promise<{ status: number; body: Record<string, any> }> => {
  const res = await route(
    new NextRequest(`http://localhost${url}`, { headers: { authorization: 'Bearer token' } }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  adminState.client = adminClient().client;
});

describe('Security invariant: the phone storefront reads never use the cookie client', () => {
  it('fixture: the viewer sees a strict, non-empty part of the catalog', () => {
    expect(VISIBLE.length).toBeGreaterThan(5);
    expect(VISIBLE.length).toBeLessThan(ALL_ORDERABLE.length);
  });

  it('storefront: the warehouses, the profile and the org row come from the caller client', async () => {
    const caller = asCaller('viewer');
    const { status, body } = await get(GET_STOREFRONT, '/api/v1/orders/storefront');
    expect(status).toBe(200);
    expect(body.warehouses).toEqual([{ id: WH, name: 'DC4' }]);
    expect(body.viewer).toMatchObject({ name: 'Pat', email: 'pat@example.org', role: 'viewer' });
    expect(body.orgTimezone).toBe('America/Los_Angeles');
    expect(caller.fromCalls.sort()).toEqual(['organizations', 'user_profiles', 'warehouses']);
    expect(cookieClientMock).not.toHaveBeenCalled();
    expect(modulesForRequestMock).not.toHaveBeenCalled();
  });

  it("catalog: the viewer's rows exactly, with the scope helpers asked of the caller client", async () => {
    const caller = asCaller('viewer');
    const { status, body } = await get(GET_CATALOG, `/api/v1/orders/catalog?warehouseId=${WH}`);
    expect(status).toBe(200);
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual([...VISIBLE].sort());
    expect(caller.rpcCalls.map((c) => c.name).filter((n) => n.startsWith('rls_')).sort()).toEqual(
      SCOPE_HELPERS,
    );
    // Kits and Frequently ordered read through the caller's client too, and
    // name only rows the viewer was given.
    expect(body.kits).toEqual({
      status: 'ok',
      kits: [expect.objectContaining({ bundleId: BUNDLE, name: 'Starter Kit' })],
    });
    expect(caller.fromCalls).toContain('bundles');
    expect(body.frequentlyOrdered).toEqual({
      status: 'ok',
      items: [
        { itemId: VISIBLE[0], orders: 9 },
        { itemId: VISIBLE[1], orders: 3 },
      ],
    });
    expect(body.sites).toEqual({
      status: 'ok',
      sites: [{ id: CHARTER_MINE, name: 'North', code: 'N', address: null }],
    });
    expect(Object.keys(body.charters)).toEqual([CHARTER_MINE]);
    expect(body.aisles.map((a: { name: string }) => a.name)).toEqual(['Apparel', 'Supplies']);
    expect(JSON.stringify(body)).not.toMatch(/99\.99|55\.55|price|cost/i);
    expect(cookieClientMock).not.toHaveBeenCalled();
    expect(modulesForRequestMock).not.toHaveBeenCalled();
  });

  it("photos: the caller's scope decides which photos leave the server", async () => {
    const caller = asCaller('viewer');
    const { status, body } = await get(GET_PHOTOS, `/api/v1/orders/catalog/photos?warehouseId=${WH}`);
    expect(status).toBe(200);
    expect(Object.keys(body.photos).sort()).toEqual([...VISIBLE].sort());
    expect(caller.rpcCalls.map((c) => c.name).filter((n) => n.startsWith('rls_')).sort()).toEqual(
      SCOPE_HELPERS,
    );
    expect(cookieClientMock).not.toHaveBeenCalled();
  });

  it('an id in capitals (how Swift prints a UUID): the same rows, kit and photos, under the stored id', async () => {
    // The scope key and the kits compare warehouse ids as text, so a capital
    // id that got past the perimeter would have scoped this viewer to nothing.
    const upper = WH.toUpperCase();
    asCaller('viewer');
    const catalog = await get(GET_CATALOG, `/api/v1/orders/catalog?warehouseId=${upper}`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.warehouseId).toBe(WH);
    expect(catalog.body.items.map((i: { id: string }) => i.id).sort()).toEqual([...VISIBLE].sort());
    expect(catalog.body.kits).toEqual({
      status: 'ok',
      kits: [expect.objectContaining({ bundleId: BUNDLE })],
    });
    asCaller('viewer');
    const photos = await get(GET_PHOTOS, `/api/v1/orders/catalog/photos?warehouseId=${upper}`);
    expect(photos.status).toBe(200);
    expect(photos.body.warehouseId).toBe(WH);
    expect(Object.keys(photos.body.photos).sort()).toEqual([...VISIBLE].sort());
    expect(cookieClientMock).not.toHaveBeenCalled();
  });

  it('control: a manager sees every orderable row and asks no scope helper', async () => {
    const caller = asCaller('manager');
    const { body } = await get(GET_CATALOG, `/api/v1/orders/catalog?warehouseId=${WH}`);
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual([...ALL_ORDERABLE].sort());
    expect(caller.rpcCalls.filter((c) => c.name.startsWith('rls_'))).toEqual([]);
  });

  it("the phone's aisles are the web page's aisles for the same rows (one rule, two copies)", async () => {
    asCaller('manager');
    const { body } = await get(GET_CATALOG, `/api/v1/orders/catalog?warehouseId=${WH}`);
    const web = await loadCatalogBundle({ organizationId: ORG, userId: VIEWER, role: 'manager' }, WH);
    expect(body.aisles).toEqual(web.aisles);
    expect(body.aisles.at(-1)).toEqual({ id: null, name: 'Uncategorized', itemCount: 15 });
    // The ceiling the phone is told is the one the loader stops at.
    expect(body.rowCeiling).toBe(CATALOG_ROW_CEILING);
    expect(ORDER_CATALOG_ROW_CEILING).toBe(CATALOG_ROW_CEILING);
  });
});

describe('Security invariant: the phone storefront code names no cookie-session helper', () => {
  const SRC = path.resolve(__dirname, '../../../../..');
  const FILES = [
    'app/api/v1/orders/storefront/route.ts',
    'app/api/v1/orders/catalog/route.ts',
    'app/api/v1/orders/catalog/photos/route.ts',
    'server/loaders/orders-phone-catalog.ts',
    'server/services/order-storefront.ts',
    'server/lib/order-storefront-http.ts',
  ];
  const BANNED = ['createClient(', 'withContext(', 'requireOrgContext(', 'getModulesForRequest('];
  const codeOnly = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it.each(FILES)('%s', (file) => {
    const code = codeOnly(readFileSync(path.join(SRC, file), 'utf8'));
    expect(code.length).toBeGreaterThan(200);
    for (const banned of BANNED) expect(code).not.toContain(banned);
  });
});
