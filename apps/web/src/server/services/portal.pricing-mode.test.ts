import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The B2B portal catalog under both pricing modes.
 *
 * portalCatalog() is the single source of truth for what a customer may SEE
 * and what they may ORDER — portalSubmitOrder re-validates every submitted
 * line against this exact return set. Widening the catalog therefore widens
 * checkout with it, so the load-bearing property of this suite is that the
 * ALLOWLIST (customer_catalog, in the customer's own org, active, not
 * soft-deleted, not awaiting first receipt) is the only thing that decides
 * membership. The mode decides pricing and nothing else: a missing price used
 * to act as a second, accidental allowlist, and that is what left a no-charge
 * org's portal empty.
 *
 * The admin client below is an in-memory PostgREST stand-in that APPLIES the
 * filters the service asks for rather than replaying a canned rowset — so the
 * fixtures deliberately contain an inactive item, an expected item, a deleted
 * item, another customer's item and another org's item, and every exclusion
 * assertion is proved by the service's own query, not by the mock.
 */

type Row = Record<string, unknown>;

const { adminRef, authUser } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  authUser: { current: null as { id: string } | null },
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
// The cookie-bound client. resolvePortalContext uses it for TWO things: the
// auth.getUser() identity read, and the account-status read that gates the
// portal on user_profiles.disabled_at (see lib/auth/account-status.ts — the
// portal is install point 3 of 3, because it resolves identity itself and then
// reads with the service-role client). An active row is the default here; the
// disabled case is proved in src/lib/auth/account-status.test.ts.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser.current }, error: null }) },
    from: () => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      q.select = self;
      q.eq = self;
      q.maybeSingle = async () => ({ data: { disabled_at: null }, error: null });
      return q;
    },
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));

import {
  portalCatalog,
  portalSubmitOrder,
  resolvePortalContext,
  type PortalContext,
} from './portal';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER_CUSTOMER = '44444444-4444-4444-8444-444444444445';
/** Same org, invited, but nothing allowlisted to them yet. */
const EMPTY_CUSTOMER = '44444444-4444-4444-8444-444444444446';
const PRICE_LIST = '55555555-5555-4555-8555-555555555555';
const WAREHOUSE = '66666666-6666-4666-8666-666666666666';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const ITEM_INACTIVE = '33333333-3333-4333-8333-333333333331';
const ITEM_EXPECTED = '33333333-3333-4333-8333-333333333332';
const ITEM_DELETED = '33333333-3333-4333-8333-333333333333';
const ITEM_NOT_ALLOWED = '77777777-7777-4777-8777-777777777777';
const ITEM_OTHER_ORG = '88888888-8888-4888-8888-888888888888';

/** An inventory row with the columns portalCatalog + portalSubmitOrder read. */
function item(id: string, over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    warehouse_id: WAREHOUSE,
    name: `Item ${id.slice(0, 4)}`,
    sku: `SKU-${id.slice(0, 4)}`,
    quantity_on_hand: 28,
    unit_cost: 4.25,
    status: 'active',
    awaiting_first_receipt: false,
    deleted_at: null,
    ...over,
  };
}

function makeDb(): Record<string, Row[]> {
  return {
    inventory_items: [
      item(ITEM_A),
      item(ITEM_B, { quantity_on_hand: 3 }),
      item(ITEM_INACTIVE, { status: 'inactive' }),
      item(ITEM_EXPECTED, { awaiting_first_receipt: true }),
      item(ITEM_DELETED, { deleted_at: '2026-07-01T00:00:00Z' }),
      item(ITEM_NOT_ALLOWED),
      item(ITEM_OTHER_ORG, { organization_id: OTHER_ORG }),
    ],
    // The allowlist deliberately includes the three item-level exclusions and
    // a cross-org row: if any of them surfaces, the catalog gate has widened
    // past the customer's own, orderable items.
    customer_catalog: [
      { customer_id: CUSTOMER, item_id: ITEM_A },
      { customer_id: CUSTOMER, item_id: ITEM_B },
      { customer_id: CUSTOMER, item_id: ITEM_INACTIVE },
      { customer_id: CUSTOMER, item_id: ITEM_EXPECTED },
      { customer_id: CUSTOMER, item_id: ITEM_DELETED },
      { customer_id: CUSTOMER, item_id: ITEM_OTHER_ORG },
      { customer_id: OTHER_CUSTOMER, item_id: ITEM_NOT_ALLOWED },
    ],
    // ITEM_B has no entry (quotable); ITEM_NOT_ALLOWED has one, proving a
    // price never grants membership on its own.
    price_list_items: [
      { price_list_id: PRICE_LIST, item_id: ITEM_A, unit_price: 12.5 },
      { price_list_id: PRICE_LIST, item_id: ITEM_NOT_ALLOWED, unit_price: 5 },
    ],
    order_requests: [],
    order_request_lines: [],
  };
}

/**
 * Minimal in-memory admin client: chainable like the real builder, but eq/in/
 * is/range actually filter, so the service's own predicates decide the rowset.
 *
 * `failTables` makes a named table's reads come back the way PostgREST reports
 * a transient failure — `{ data: null, error: { message } }` — which is the
 * exact shape a swallow-the-error reader turns into a silent empty rowset.
 */
function makeAdmin(db: Record<string, Row[]>, failTables: Record<string, string> = {}) {
  const fromCalls: string[] = [];
  const inserts: Array<{ table: string; rows: Row[] }> = [];
  // Records the size of every `.in()` call, per table — lets a test prove a
  // large id list actually got chunked into multiple bounded calls, rather
  // than one `.in(...)` (which this in-memory client would happily accept
  // even unchunked, since it doesn't emulate PostgREST's max_rows cap).
  const inCallSizes: Record<string, number[]> = {};

  function chain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let written: Row[] | null = null;
    let window: [number, number] | null = null;

    const rows = (): Row[] => {
      if (written) return written;
      const all = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      return window ? all.slice(window[0], window[1] + 1) : all;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        (inCallSizes[table] ??= []).push(vals.length);
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      is: (col: string, val: unknown) => {
        preds.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      range: (from: number, to: number) => {
        window = [from, to];
        return builder;
      },
      insert: (payload: Row | Row[]) => {
        const added = (Array.isArray(payload) ? payload : [payload]).map((r, i) => ({
          id: `${table}-${i + 1}`,
          ...r,
        }));
        inserts.push({ table, rows: added });
        (db[table] ??= []).push(...added);
        written = added;
        return builder;
      },
      update: () => builder,
      delete: () => builder,
      maybeSingle: async () =>
        failTables[table]
          ? { data: null, error: { message: failTables[table] } }
          : { data: rows()[0] ?? null, error: null },
      single: async () =>
        failTables[table]
          ? { data: null, error: { message: failTables[table] } }
          : { data: rows()[0] ?? null, error: null },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => void) =>
        resolve(
          failTables[table]
            ? { data: null, error: { message: failTables[table]! } }
            : { data: rows(), error: null },
        ),
    };
    return builder;
  }

  return {
    client: {
      from: (table: string) => {
        fromCalls.push(table);
        return chain(table);
      },
    },
    fromCalls,
    inserts,
    inCallSizes,
  };
}

const BASE_CTX = {
  userId: 'auth-1',
  email: 'buyer@school.example.com',
  customerId: CUSTOMER,
  customerName: 'Harbor Elementary',
  organizationId: ORG,
  orgName: 'L4L North Region',
  orgLogoUrl: null,
};

const ctxNoCharge: PortalContext = {
  ...BASE_CTX,
  priceListId: null,
  pricingMode: 'no_charge',
};
const ctxNoChargeWithPriceList: PortalContext = {
  ...BASE_CTX,
  priceListId: PRICE_LIST,
  pricingMode: 'no_charge',
};
const ctxPriced: PortalContext = {
  ...BASE_CTX,
  priceListId: PRICE_LIST,
  pricingMode: 'priced',
};
const ctxNoChargeEmptyAllowlist: PortalContext = {
  ...ctxNoCharge,
  customerId: EMPTY_CUSTOMER,
};

let admin: ReturnType<typeof makeAdmin>;

beforeEach(() => {
  vi.clearAllMocks();
  admin = makeAdmin(makeDb());
  adminRef.current = admin.client;
  authUser.current = { id: 'auth-1' };
});

describe('portalCatalog — pricing modes', () => {
  it('no_charge: returns every allowlisted item even with NO price list', async () => {
    const rows = await portalCatalog(ctxNoCharge);
    expect(rows.map((r) => r.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    expect(rows.every((r) => r.unitPrice === null)).toBe(true);
    expect(rows.every((r) => r.quotable === false)).toBe(true);
  });

  it('no_charge: ignores the price list entirely when one happens to exist', async () => {
    const rows = await portalCatalog(ctxNoChargeWithPriceList);
    expect(rows.map((r) => r.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    expect(rows.every((r) => r.unitPrice === null)).toBe(true);
    // Not merely priced-then-nulled: the price list is never even read.
    expect(admin.fromCalls).not.toContain('price_list_items');
  });

  it('priced: shows unpriced allowlisted items as quotable rather than hiding them', async () => {
    const rows = await portalCatalog(ctxPriced);
    const a = rows.find((r) => r.itemId === ITEM_A);
    const b = rows.find((r) => r.itemId === ITEM_B);
    expect(a?.unitPrice).toBe(12.5);
    expect(a?.quotable).toBe(false);
    expect(b).toBeDefined(); // the old behaviour hid it
    expect(b?.unitPrice).toBeNull();
    expect(b?.quotable).toBe(true);
  });

  it('exposes the real on-hand quantity in both modes', async () => {
    expect((await portalCatalog(ctxNoCharge))[0]?.quantityAvailable).toBe(28);
    expect((await portalCatalog(ctxPriced))[0]?.quantityAvailable).toBe(28);
  });

  it('still never projects cost or bin', async () => {
    const row = (await portalCatalog(ctxPriced))[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ['imageUrl', 'itemId', 'name', 'quantityAvailable', 'quotable', 'sku', 'unitPrice'].sort(),
    );
  });
});

describe('portalCatalog — a failed read fails the catalog, it never fakes one', () => {
  /**
   * The failure this suite exists for: a transient price_list_items error used
   * to be swallowed, leaving `prices` empty. In a PRICED org that is not a
   * degraded read, it is a WRONG one — every allowlisted item turns quotable
   * with a null price, the customer is invited to "Request quote" on goods
   * they are genuinely billed for, and checkout stamps
   * unit_price_at_request = 0 onto real order_request_lines. There is no
   * recovery from that write, so the read must fail loudly instead.
   */
  it('priced: a failing price read throws instead of returning a quotable catalog', async () => {
    admin = makeAdmin(makeDb(), { price_list_items: 'connection reset' });
    adminRef.current = admin.client;

    await expect(portalCatalog(ctxPriced)).rejects.toThrow(/could not be loaded/i);
  });

  it('priced: and checkout therefore cannot record a zero price from that failure', async () => {
    admin = makeAdmin(makeDb(), { price_list_items: 'connection reset' });
    adminRef.current = admin.client;

    await expect(
      portalSubmitOrder(ctxPriced, { lines: [{ itemId: ITEM_A, quantity: 3 }] }),
    ).rejects.toThrow(/could not be loaded/i);
    expect(admin.inserts.find((i) => i.table === 'order_request_lines')).toBeUndefined();
    expect(admin.inserts.find((i) => i.table === 'order_requests')).toBeUndefined();
  });

  it('a failing allowlist read throws rather than rendering an empty catalog', async () => {
    admin = makeAdmin(makeDb(), { customer_catalog: 'connection reset' });
    adminRef.current = admin.client;

    await expect(portalCatalog(ctxNoCharge)).rejects.toThrow(/could not be loaded/i);
  });
});

describe('portalCatalog — the allowlist is still the only gate', () => {
  it('still excludes inactive, deleted and awaiting-first-receipt items in both modes', async () => {
    for (const ctx of [ctxNoCharge, ctxPriced]) {
      const ids = (await portalCatalog(ctx)).map((r) => r.itemId);
      expect(ids).not.toContain(ITEM_INACTIVE);
      expect(ids).not.toContain(ITEM_EXPECTED);
      expect(ids).not.toContain(ITEM_DELETED);
    }
  });

  it('never returns another organisation’s item, even when the allowlist points at it', async () => {
    expect((await portalCatalog(ctxNoCharge)).map((r) => r.itemId)).not.toContain(ITEM_OTHER_ORG);
  });

  it('never returns an item allowlisted to a DIFFERENT customer, priced or not', async () => {
    expect((await portalCatalog(ctxPriced)).map((r) => r.itemId)).not.toContain(ITEM_NOT_ALLOWED);
    expect((await portalCatalog(ctxNoCharge)).map((r) => r.itemId)).not.toContain(ITEM_NOT_ALLOWED);
  });

  it('still returns nothing when the allowlist is empty, in either mode', async () => {
    expect(await portalCatalog(ctxNoChargeEmptyAllowlist)).toEqual([]);
    expect(await portalCatalog({ ...ctxPriced, customerId: EMPTY_CUSTOMER })).toEqual([]);
  });
});

describe('portalCatalog — the final inventory_items read is chunked', () => {
  it('returns the FULL set when the allowlist spans more than one 500-id batch', async () => {
    // 650 > one batch (500), so covering it proves the id list was actually
    // split and stitched back together, not just handed to one `.in(...)`.
    const bulkIds = Array.from({ length: 650 }, (_, n) => `bulk-${String(n).padStart(4, '0')}`);
    const db = makeDb();
    db.inventory_items = bulkIds.map((id) => item(id));
    db.customer_catalog = bulkIds.map((id) => ({ customer_id: CUSTOMER, item_id: id }));
    admin = makeAdmin(db);
    adminRef.current = admin.client;

    const rows = await portalCatalog(ctxNoCharge);

    expect(rows.map((r) => r.itemId).sort()).toEqual([...bulkIds].sort());
    // And prove it via the read pattern itself, not just the result: more
    // than one `.in()` call against inventory_items, each within the 500-id
    // batch size, together covering exactly the 650 requested ids.
    const sizes = admin.inCallSizes.inventory_items ?? [];
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((n) => n <= 500)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(650);
  });
});

describe('portalSubmitOrder — checkout tracks the catalog exactly', () => {
  it('checkout accepts exactly what the catalog showed, in no_charge mode', async () => {
    const rows = await portalCatalog(ctxNoCharge);
    await expect(
      portalSubmitOrder(ctxNoCharge, { lines: [{ itemId: rows[0]!.itemId, quantity: 1 }] }),
    ).resolves.toBeTruthy();
  });

  it('checkout still rejects an item that is not on the allowlist', async () => {
    await expect(
      portalSubmitOrder(ctxNoCharge, { lines: [{ itemId: ITEM_NOT_ALLOWED, quantity: 1 }] }),
    ).rejects.toThrow(/no longer available/);
  });

  it('checkout still rejects an inactive / expected / cross-org allowlisted item', async () => {
    for (const id of [ITEM_INACTIVE, ITEM_EXPECTED, ITEM_DELETED, ITEM_OTHER_ORG]) {
      await expect(
        portalSubmitOrder(ctxPriced, { lines: [{ itemId: id, quantity: 1 }] }),
      ).rejects.toThrow(/no longer available/);
    }
  });

  it('records NO price for a no-charge line, and the cost snapshot as always', async () => {
    await portalSubmitOrder(ctxNoCharge, { lines: [{ itemId: ITEM_A, quantity: 2 }] });
    const lines = admin.inserts.find((i) => i.table === 'order_request_lines')!.rows;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      item_id: ITEM_A,
      quantity_requested: 2,
      // NULL, not 0 — nothing was priced, so nothing was agreed at zero.
      unit_price_at_request: null,
      unit_cost_at_request: 4.25,
    });
  });

  it('records the customer price in priced mode, and NO price for a quotable line', async () => {
    await portalSubmitOrder(ctxPriced, {
      lines: [
        { itemId: ITEM_A, quantity: 1 },
        { itemId: ITEM_B, quantity: 1 },
      ],
    });
    const lines = admin.inserts.find((i) => i.table === 'order_request_lines')!.rows;
    expect(lines.find((l) => l.item_id === ITEM_A)?.unit_price_at_request).toBe(12.5);
    // ITEM_B is quotable: to-be-quoted must be distinguishable from agreed-free.
    expect(lines.find((l) => l.item_id === ITEM_B)?.unit_price_at_request).toBeNull();
  });
});

describe('resolvePortalContext — the mode comes from the org', () => {
  function seedOrg(settings: unknown, enabled = true) {
    const db = makeDb();
    db.customer_users = [
      {
        customer_id: CUSTOMER,
        user_id: 'auth-1',
        email: 'buyer@school.example.com',
        accepted_at: '2026-07-01T00:00:00Z',
        invited_at: '2026-06-01T00:00:00Z',
        customer: {
          id: CUSTOMER,
          name: 'Harbor Elementary',
          status: 'active',
          organization_id: ORG,
          price_list_id: null,
        },
      },
    ];
    db.organization_modules = [
      { organization_id: ORG, module_id: 'b2b_portal', enabled, settings },
    ];
    db.organizations = [
      { id: ORG, name: 'L4L North Region', logo_url: null, plan: null, access_tier: 'business' },
    ];
    admin = makeAdmin(db);
    adminRef.current = admin.client;
  }

  it('reads an explicit priced mode out of the b2b_portal module settings', async () => {
    seedOrg({ pricingMode: 'priced' });
    const ctx = await resolvePortalContext();
    expect(ctx?.pricingMode).toBe('priced');
  });

  it('defaults to no_charge when the module carries no setting at all', async () => {
    seedOrg(null);
    const ctx = await resolvePortalContext();
    expect(ctx?.pricingMode).toBe('no_charge');
  });

  // Test gap named in review: both cases above seed enabled:true, so nothing
  // exercised the module gate itself. resolvePortalContext must refuse the
  // WHOLE portal (not just fall back on pricing mode) once b2b_portal is
  // disabled for the org — mirrors the org-side gate.
  it('returns null — no portal at all — when the b2b_portal module row is disabled', async () => {
    seedOrg({ pricingMode: 'priced' }, false);
    const ctx = await resolvePortalContext();
    expect(ctx).toBeNull();
  });
});
