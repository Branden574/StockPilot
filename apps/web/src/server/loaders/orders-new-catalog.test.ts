import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const { createAdminClientMock, createClientMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

// The caller's OWN cookie client: the catalog scope is read through it, so the
// policy helpers see the caller's auth.uid().
vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));

import {
  FULL_CATALOG_SCOPE_KEY,
  loadCatalogBundle,
  loadCatalogItems,
  loadCatalogThumbMapCached,
  loadChartersForWarehouse,
  resolveCatalogScopeKey,
  type CatalogViewer,
} from './orders-new-catalog';

const ORG = '00000000-0000-4000-8000-00000000000a';
const WH = '00000000-0000-4000-8000-0000000000b1';
const WH2 = '00000000-0000-4000-8000-0000000000b2';
const CHARTER_A = '00000000-0000-4000-8000-0000000000c1';
const CHARTER_B = '00000000-0000-4000-8000-0000000000c2';
const CAT_X = '00000000-0000-4000-8000-0000000000d1';
const CAT_Y = '00000000-0000-4000-8000-0000000000d2';

const viewer = (role: CatalogViewer['role']): CatalogViewer => ({
  organizationId: ORG,
  userId: 'user-1',
  role,
});

// Expected-items visibility (mig 0277): the storefront/new-order catalog
// loader must exclude items awaiting their first receipt AT THE QUERY —
// a phantom auto-created from an inbound PO is not orderable until stock
// arrives. (Server-side order-line validation is the second gate; this
// keeps them out of the picker in the first place.)
describe('loadCatalogItems — expected-items exclusion (mig 0277)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies eq(awaiting_first_receipt, false) alongside the existing active/non-rental predicates', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          {
            id: 'i-1',
            name: 'Dell XPS',
            sku: 'SKU-1',
            quantity_on_hand: 0,
            warehouse_id: 'wh-1',
            item_type: 'product',
            bin_location: null,
            category_id: null,
            charter_id: null,
            retail_price: 900,
            unit_cost: 700,
            reorder_point: 2,
            rack_number: null,
            rack_row: null,
            book_rack_number: null,
            book_rack_row: null,
          },
        ],
        error: null,
      },
      'stock_reservations.select': { data: [], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);

    // An admin's scope is the full one by role: no scope read at all.
    const items = await loadCatalogItems(
      { organizationId: 'org-1', userId: 'user-1', role: 'admin' },
      'wh-1',
    );

    // The unflagged (established, even zero-stock) item still lists.
    expect(items.map((i) => i.id)).toEqual(['i-1']);

    // The items query carries the mig-0277 exclusion, next to the
    // existing predicates — asserted on the recorded builder chain.
    const chains = stub.chainsAll.get('inventory_items.select') ?? [];
    const argsAll = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(chains.length).toBe(1);
    const eqCalls = chains[0]!
      .map((m, idx) => ({ m, args: argsAll[0]![idx] }))
      .filter((c) => c.m === 'eq')
      .map((c) => c.args);
    expect(eqCalls).toContainEqual(['awaiting_first_receipt', false]);
    expect(eqCalls).toContainEqual(['status', 'active']);
    expect(eqCalls).toContainEqual(['is_rental', false]);
    expect(eqCalls).toContainEqual(['organization_id', 'org-1']);
    expect(eqCalls).toContainEqual(['warehouse_id', 'wh-1']);
  });
});

/* ---- the catalog never holds a row RLS would hide from the caller ---- */

interface Row {
  id: string;
  organization_id: string;
  warehouse_id: string;
  charter_id: string | null;
  category_id: string | null;
}

function item(id: string, warehouse: string, charter: string | null, category: string | null): Row {
  return {
    id,
    organization_id: ORG,
    warehouse_id: warehouse,
    charter_id: charter,
    category_id: category,
  };
}

// One warehouse holding generic stock and two charters' stock, across two
// categories and "no category". WH2 is another warehouse of the same org.
const ROWS: Row[] = [
  item('g-x', WH, null, CAT_X),
  item('g-y', WH, null, CAT_Y),
  item('g-none', WH, null, null),
  item('a-x', WH, CHARTER_A, CAT_X),
  item('a-y', WH, CHARTER_A, CAT_Y),
  item('b-x', WH, CHARTER_B, CAT_X),
  item('b-y', WH, CHARTER_B, CAT_Y),
  item('b-none', WH, CHARTER_B, null),
  item('w2-a-x', WH2, CHARTER_A, CAT_X),
];
const ALL_AT_WH = ['a-x', 'a-y', 'b-none', 'b-x', 'b-y', 'g-none', 'g-x', 'g-y'];

/**
 * An admin client whose inventory_items reads are EVALUATED against ROWS with
 * the filters the loader actually applied (eq, is null, in, or-groups), so a
 * test sees the rows the query would return, not a canned answer.
 */
function makeFilteringAdmin(rows: Row[]) {
  const itemQueries: Array<Array<[string, unknown[]]>> = [];
  const matchTerm = (row: Record<string, unknown>, term: string): boolean => {
    const [col, op, ...rest] = term.split('.');
    const value = rest.join('.');
    if (op === 'is' && value === 'null') return row[col!] === null;
    if (op === 'eq') return String(row[col!]) === value;
    if (op === 'in')
      return value
        .slice(1, -1)
        .split(',')
        .includes(row[col!] as string);
    throw new Error(`fake: unsupported or-term ${term}`);
  };
  const splitTop = (expr: string) => {
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
  const evaluate = (calls: Array<[string, unknown[]]>) => {
    let out = rows.map((r) => ({
      ...r,
      name: r.id,
      sku: r.id.toUpperCase(),
      quantity_on_hand: 5,
      item_type: 'product',
      bin_location: null,
      retail_price: 1,
      unit_cost: 1,
      reorder_point: 0,
      rack_number: null,
      rack_row: null,
      book_rack_number: null,
      book_rack_row: null,
      status: 'active',
      is_rental: false,
      awaiting_first_receipt: false,
      deleted_at: null,
      is_bundle: null,
    })) as Array<Record<string, unknown>>;
    let limit = Infinity;
    for (const [m, args] of calls) {
      if (m === 'eq') out = out.filter((r) => r[args[0] as string] === args[1]);
      else if (m === 'is') out = out.filter((r) => r[args[0] as string] === args[1]);
      else if (m === 'in')
        out = out.filter((r) => (args[1] as unknown[]).includes(r[args[0] as string]));
      else if (m === 'or')
        out = out.filter((r) => splitTop(args[0] as string).some((t) => matchTerm(r, t)));
      else if (m === 'limit') limit = args[0] as number;
      else if (m !== 'select' && m !== 'order') throw new Error(`fake: unsupported ${m}`);
    }
    return out.slice(0, limit);
  };
  const client = {
    from: vi.fn((table: string) => {
      const calls: Array<[string, unknown[]]> = [];
      if (table === 'inventory_items') itemQueries.push(calls);
      const builder: object = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: table === 'inventory_items' ? evaluate(calls) : [], error: null });
            }
            return (...args: unknown[]) => {
              calls.push([prop, args]);
              return builder;
            };
          },
        },
      );
      return builder;
    }),
  };
  return { client, itemQueries };
}

type RpcAnswer = { data: unknown; error: { message: string } | null };

/**
 * The caller's cookie client. Each policy helper answers with the sets the SQL
 * helper would return FOR THIS CALLER (see 0229 / 0310), as PostgREST shapes
 * them: `setof uuid` as a bare string array, `returns table` as objects.
 */
function makeCallerClient(answers: {
  full?: string[];
  assigned?: string[];
  pairs?: Array<{ warehouse_id: string; charter_id: string }>;
  unrestricted?: string[];
  allowed?: Array<{ organization_id: string; category_id: string }>;
  override?: Record<string, RpcAnswer>;
}) {
  const byName: Record<string, RpcAnswer> = {
    rls_inv_read_full_warehouse_ids: { data: answers.full ?? [], error: null },
    rls_inv_read_assigned_warehouse_ids: { data: answers.assigned ?? [], error: null },
    rls_inv_read_warehouse_charter_ids: { data: answers.pairs ?? [], error: null },
    rls_cat_unrestricted_org_ids: { data: answers.unrestricted ?? [], error: null },
    rls_cat_allowed_category_ids: { data: answers.allowed ?? [], error: null },
    ...answers.override,
  };
  const rpc = vi.fn(async (name: string) => {
    const answer = byName[name];
    if (!answer) throw new Error(`unexpected rpc ${name}`);
    return answer;
  });
  return { rpc };
}

async function catalogIds(
  role: CatalogViewer['role'],
  caller: ReturnType<typeof makeCallerClient>,
) {
  const admin = makeFilteringAdmin(ROWS);
  createAdminClientMock.mockReturnValue(admin.client);
  createClientMock.mockResolvedValue(caller);
  const items = await loadCatalogItems(viewer(role), WH);
  return { ids: items.map((i) => i.id).sort(), admin };
}

describe("loadCatalogItems — the catalog is the caller's RLS view of the warehouse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a viewer assigned to charter A sees generic stock and charter A, never charter B', async () => {
    const { ids } = await catalogIds(
      'viewer',
      makeCallerClient({
        assigned: [WH],
        pairs: [{ warehouse_id: WH, charter_id: CHARTER_A }],
        unrestricted: [ORG],
      }),
    );
    expect(ids).toEqual(['a-x', 'a-y', 'g-none', 'g-x', 'g-y']);
  });

  it('a staff member assigned to charter B sees generic stock and charter B, never charter A', async () => {
    const { ids } = await catalogIds(
      'staff',
      makeCallerClient({
        assigned: [WH],
        pairs: [{ warehouse_id: WH, charter_id: CHARTER_B }],
        unrestricted: [ORG],
      }),
    );
    expect(ids).toEqual(['b-none', 'b-x', 'b-y', 'g-none', 'g-x', 'g-y']);
  });

  it('a charter assignment at ANOTHER warehouse opens nothing here', async () => {
    const { ids, admin } = await catalogIds(
      'viewer',
      makeCallerClient({
        assigned: [WH2],
        pairs: [{ warehouse_id: WH2, charter_id: CHARTER_A }],
        unrestricted: [ORG],
      }),
    );
    expect(ids).toEqual([]);
    expect(admin.itemQueries).toHaveLength(0);
  });

  it('a category-restricted viewer sees only granted categories, never another or none', async () => {
    const { ids } = await catalogIds(
      'viewer',
      makeCallerClient({
        full: [WH],
        assigned: [WH],
        allowed: [{ organization_id: ORG, category_id: CAT_X }],
      }),
    );
    expect(ids).toEqual(['a-x', 'b-x', 'g-x']);
  });

  it('charter and category restrictions apply together', async () => {
    const { ids } = await catalogIds(
      'viewer',
      makeCallerClient({
        assigned: [WH],
        pairs: [{ warehouse_id: WH, charter_id: CHARTER_A }],
        allowed: [
          { organization_id: ORG, category_id: CAT_Y },
          // A grant in another organization says nothing about this one.
          { organization_id: '00000000-0000-4000-8000-0000000000ff', category_id: CAT_X },
        ],
      }),
    );
    expect(ids).toEqual(['a-y', 'g-y']);
  });

  it('a FULL view of ANOTHER warehouse widens nothing here', async () => {
    // Full access is per warehouse: full at WH2 says nothing about WH, where
    // this staff member holds charter A only.
    const { ids } = await catalogIds(
      'staff',
      makeCallerClient({
        full: [WH2],
        assigned: [WH, WH2],
        pairs: [{ warehouse_id: WH, charter_id: CHARTER_A }],
        unrestricted: [ORG],
      }),
    );
    expect(ids).toEqual(['a-x', 'a-y', 'g-none', 'g-x', 'g-y']);
  });

  it('being category-unrestricted in ANOTHER organization lifts no grant here', async () => {
    const { ids } = await catalogIds(
      'viewer',
      makeCallerClient({
        full: [WH],
        assigned: [WH],
        unrestricted: ['00000000-0000-4000-8000-0000000000ff'],
        allowed: [{ organization_id: ORG, category_id: CAT_X }],
      }),
    );
    expect(ids).toEqual(['a-x', 'b-x', 'g-x']);
  });

  it('a staff member whose view of the warehouse is full gets the shared ALL variant', async () => {
    const caller = makeCallerClient({ full: [WH], assigned: [WH], unrestricted: [ORG] });
    createClientMock.mockResolvedValue(caller);
    await expect(resolveCatalogScopeKey(viewer('staff'), WH)).resolves.toBe(FULL_CATALOG_SCOPE_KEY);

    const { ids } = await catalogIds('staff', caller);
    expect(ids).toEqual(ALL_AT_WH);
  });

  it.each(['owner', 'admin', 'manager'] as const)(
    '%s: the full catalog, with no scope read (no added round trip)',
    async (role) => {
      const { ids } = await catalogIds(role, makeCallerClient({}));
      expect(ids).toEqual(ALL_AT_WH);
      expect(createClientMock).not.toHaveBeenCalled();
      await expect(resolveCatalogScopeKey(viewer(role), WH)).resolves.toBe(FULL_CATALOG_SCOPE_KEY);
    },
  );
});

// Every read that decides the scope fails CLOSED: supabase-js resolves a
// failed query as { data: null, error }, and no scope may be built from it.
describe('loadCatalogItems — a failed scope read denies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'rls_inv_read_full_warehouse_ids',
    'rls_inv_read_assigned_warehouse_ids',
    'rls_inv_read_warehouse_charter_ids',
    'rls_cat_unrestricted_org_ids',
    'rls_cat_allowed_category_ids',
  ])('%s failing rejects the catalog and reads no items', async (name) => {
    const admin = makeFilteringAdmin(ROWS);
    createAdminClientMock.mockReturnValue(admin.client);
    createClientMock.mockResolvedValue(
      makeCallerClient({
        full: [WH],
        assigned: [WH],
        unrestricted: [ORG],
        override: { [name]: { data: null, error: { message: 'fetch failed' } } },
      }),
    );

    // Refused for the ERROR, not merely because null is not an array.
    await expect(loadCatalogItems(viewer('viewer'), WH)).rejects.toThrow(
      new RegExp(`catalog scope: ${name} failed`),
    );
    expect(admin.itemQueries).toHaveLength(0);
  });

  it('an answer in an unexpected shape rejects rather than guessing', async () => {
    const admin = makeFilteringAdmin(ROWS);
    createAdminClientMock.mockReturnValue(admin.client);
    createClientMock.mockResolvedValue(
      makeCallerClient({
        override: {
          rls_inv_read_full_warehouse_ids: { data: [{ id: WH }], error: null },
        },
      }),
    );

    await expect(loadCatalogItems(viewer('staff'), WH)).rejects.toThrow(/unexpected shape/);
    expect(admin.itemQueries).toHaveLength(0);
  });
});

/* ---- throw-don't-cache: no cached loader stores a failure as data ---- */

// Every loader below runs inside unstable_cache, which stores whatever the
// callback RESOLVES with and nothing when it throws. supabase-js resolves a
// failed query as { data: null, error }, so each of these used to turn a
// failure into a cached "empty" answer.
describe('storefront loaders throw on a failed read instead of caching it', () => {
  const ITEM = {
    id: 'i-1',
    name: 'Chromebook',
    sku: 'CB-1',
    quantity_on_hand: 10,
    warehouse_id: WH,
    item_type: 'product',
    bin_location: null,
    category_id: CAT_X,
    charter_id: CHARTER_A,
    retail_price: 200,
    unit_cost: 150,
    reorder_point: 0,
    rack_number: null,
    rack_row: null,
    book_rack_number: null,
    book_rack_row: null,
  };
  const FAILED = { data: null, error: { message: 'fetch failed' } };
  const owner = viewer('owner');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('catalog items: a failed items read rejects (was an empty catalog for 60 s)', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': FAILED });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadCatalogItems(owner, WH)).rejects.toThrow(/catalog items read failed/);
  });

  it('catalog items: a failed reservations read rejects (was "nothing reserved")', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [ITEM], error: null },
      'stock_reservations.select': FAILED,
      'categories.select': { data: [{ id: CAT_X, name: 'Tech' }], error: null },
      'charters.select': { data: [{ id: CHARTER_A, name: 'A', code: null }], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadCatalogItems(owner, WH)).rejects.toThrow(/reservations read failed/);
  });

  it('catalog items: a failed category-name read rejects', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [ITEM], error: null },
      'stock_reservations.select': { data: [], error: null },
      'categories.select': FAILED,
      'charters.select': { data: [{ id: CHARTER_A, name: 'A', code: null }], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadCatalogItems(owner, WH)).rejects.toThrow(/category names read failed/);
  });

  it('catalog items: a failed charter-name read rejects', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [ITEM], error: null },
      'stock_reservations.select': { data: [], error: null },
      'categories.select': { data: [{ id: CAT_X, name: 'Tech' }], error: null },
      'charters.select': FAILED,
    });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadCatalogItems(owner, WH)).rejects.toThrow(/charter names read failed/);
  });

  it('catalog items: reads that succeed still produce the card (reserved stock counted)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [ITEM], error: null },
      'stock_reservations.select': { data: [{ item_id: 'i-1', quantity: 3 }], error: null },
      'categories.select': { data: [{ id: CAT_X, name: 'Tech' }], error: null },
      'charters.select': { data: [{ id: CHARTER_A, name: 'Alpha', code: 'A' }], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);
    const [card] = await loadCatalogItems(owner, WH);
    expect(card).toMatchObject({
      id: 'i-1',
      reservedQuantity: 3,
      categoryName: 'Tech',
      charterName: 'Alpha',
      charterCode: 'A',
    });
  });

  it('thumb map: a failed image-rows read rejects (was an empty map for 4 h), signs nothing', async () => {
    const stub = makeSupabaseStub({ 'item_images.select': FAILED });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadCatalogThumbMapCached(ORG, WH)).rejects.toThrow(/image rows read failed/);
    expect(stub.client.storage.from).not.toHaveBeenCalled();
  });

  it('thumb map failure: the bundle still renders this request, photo-less', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': FAILED,
      'inventory_items.select': { data: [ITEM], error: null },
      'stock_reservations.select': { data: [], error: null },
      'categories.select': { data: [{ id: CAT_X, name: 'Tech' }], error: null },
      'charters.select': { data: [{ id: CHARTER_A, name: 'Alpha', code: 'A' }], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = await loadCatalogBundle(owner, WH);
    expect(bundle.items.map((i) => [i.id, i.imageUrl])).toEqual([['i-1', null]]);
    warn.mockRestore();
  });

  it('charters: a failed warehouse_charters read rejects (was "no sites" for 5 min)', async () => {
    const stub = makeSupabaseStub({ 'warehouse_charters.select': FAILED });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadChartersForWarehouse(WH)).rejects.toThrow(/warehouse charters read failed/);
  });

  it('charters: a successful read lists the active charters', async () => {
    const stub = makeSupabaseStub({
      'warehouse_charters.select': {
        data: [
          { charter: { id: CHARTER_A, name: 'Alpha', code: 'A', status: 'active', address: null } },
          {
            charter: { id: CHARTER_B, name: 'Beta', code: null, status: 'archived', address: null },
          },
        ],
        error: null,
      },
    });
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadChartersForWarehouse(WH)).resolves.toEqual([
      { id: CHARTER_A, name: 'Alpha', code: 'A', address: null },
    ]);
  });
});
