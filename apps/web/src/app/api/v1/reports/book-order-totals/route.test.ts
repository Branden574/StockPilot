// Security invariant: the Book Order Totals read routes (/api/v1, cookie or
// Bearer). The gate (reports:read with the MFA step-up, the orders and books
// modules) runs before the query is judged; a query must name its warehouse
// (the web's view cookie is never read by a route); the organization is the
// verified context's and is echoed so a client can drop another workspace's
// answer; a hidden book is 404; covers take 1 to 25 ids; a timeout says so;
// every answer is private and never cached, and a failure is never zeros.
// The ORDER's charter (0382) reaches the database only when chosen; a
// malformed charter is a 400 naming `charter` before any read; a charter the
// caller may not report on is ONE 400 invalid_charter whose body is the same
// whatever the cause, on the page and the drill-down alike.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co' } }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn(async () => 'cookie-warehouse'),
}));
vi.mock('@/server/services/item-images', () => ({ ItemImagesService: vi.fn() }));

import { withApiContext } from '@/lib/auth/api-context';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

import { GET as coversGET } from './covers/route';
import { GET as ordersGET } from './items/[itemId]/orders/route';
import { GET as optionsGET } from './options/route';
import { GET as totalsGET } from './route';

const W1 = '0e000000-0000-4000-8000-0000000000d1';
const ITEM = '0e000000-0000-4000-8000-000000000f01';
const CH_A = '0e000000-0000-4000-8000-0000000000a1';
/** Three ids the caller may not report on: an unknown uuid, another
 *  organization's charter, and one of this organization outside their scope.
 *  The database answers all three with the same error (pgTAP 0382 E1/E2). */
const REFUSED = [
  '0e000000-0000-4000-8000-00000000dead',
  '0e000000-0000-4000-8000-0000000000b9',
  '0e000000-0000-4000-8000-0000000000a2',
];
const INVALID_CHARTER = { code: '22023', hint: 'invalid_charter', message: 'invalid charter' };
const RANGE = {
  key: 'all',
  from: null,
  to: null,
  timeZone: 'America/Los_Angeles',
  timeZoneFallback: false,
};

const totals = {
  v: 1,
  generatedAt: '2026-09-28T17:42:00+00:00',
  generatedAtLocal: '2026-09-28 10:42',
  range: RANGE,
  statuses: [],
  filters: { warehouse: null, category: null, uncategorized: false },
  scope: { restricted: false },
  summary: {
    copies: '0',
    entries: 0,
    orders: 0,
    lines: 0,
    firstOrderAt: null,
    lastOrderAt: null,
    firstOrderDate: null,
    lastOrderDate: null,
    unresolved: { entries: 0, quantity: '0' },
  },
  totalCount: 0,
  mode: 'page',
  tooMany: false,
  maxRows: null,
  page: 1,
  pageSize: 25,
  sort: 'copies',
  rows: [],
};

function setup(
  results: Parameters<typeof makeSupabaseStub>[0],
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub(results);
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(stub.client, { organizationId: 'org-1', role: 'manager', ...over }) as never,
  );
  return stub;
}

const req = (path: string) =>
  new Request(`http://localhost/api/v1/reports/book-order-totals${path}`) as never;

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/reports/book-order-totals', () => {
  it('answers with the organization echoed, private and never cached', async () => {
    const stub = setup({ 'rpc:book_order_totals': { data: totals, error: null } });
    const res = await totalsGET(req('?warehouse=all'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.organizationId).toBe('org-1');
    expect(body.warehouse).toEqual({ id: null, source: 'all' });
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_organization_id: 'org-1',
      p_warehouse_id: null,
    });
  });
  it('400 without a warehouse; the view cookie is never read', async () => {
    const stub = setup({ 'rpc:book_order_totals': { data: totals, error: null } });
    const res = await totalsGET(req(''));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'warehouse_required' });
    expect(getActiveWarehouseFilter).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
  });
  it('400 naming invalid keys', async () => {
    setup({});
    const res = await totalsGET(req('?warehouse=all&sort=price&range=forever'));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({
      reason: 'invalid_query',
      keys: ['range', 'sort'],
    });
  });
  it('the gate comes before the query: no reports:read is 403 even for a bad query', async () => {
    setup({}, { role: 'viewer' });
    expect((await totalsGET(req('?sort=price'))).status).toBe(403);
  });
  it('the orders module off is 403 module_disabled', async () => {
    setup({}, { enabledModules: new Set(['reports', 'books', 'inventory']) as never });
    const res = await totalsGET(req('?warehouse=all'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });
  it('a statement timeout is 503 with its own words, never an empty report', async () => {
    setup({
      'rpc:book_order_totals': {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    });
    const res = await totalsGET(req('?warehouse=all'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'The report took too long. Narrow the filters and try again.',
      details: { reason: 'timeout' },
    });
  });
  it('any other failure is a fixed sentence, never database text', async () => {
    setup({
      'rpc:book_order_totals': {
        data: null,
        error: { code: 'XX000', message: 'relation "secret_table" does not exist' },
      },
    });
    const res = await totalsGET(req('?warehouse=all'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'internal_error',
      message: "Couldn't load Book Order Totals. Try again.",
    });
  });
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await totalsGET(req('?warehouse=all'))).status).toBe(401);
  });
});

describe('GET /api/v1/reports/book-order-totals: the ORDER charter (0382)', () => {
  const charterEcho = { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' };
  it('a charter reaches the database as p_charter_id only, and its echo comes back', async () => {
    const stub = setup({
      'rpc:book_order_totals': {
        data: {
          ...totals,
          filters: { ...totals.filters, charter: charterEcho, noCharter: false },
          byCharter: null,
        },
        error: null,
      },
    });
    const res = await totalsGET(req(`?warehouse=all&charter=${CH_A.toUpperCase()}&range=week`));
    expect(res.status).toBe(200);
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    // Lower-cased by core; No charter not sent at all.
    expect(args.p_charter_id).toBe(CH_A);
    expect(args).not.toHaveProperty('p_no_charter');
    expect(args.p_range).toBe('week');
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.filters.charter).toEqual(charterEcho);
    expect(body.byCharter).toBeNull();
  });
  it('No charter reaches the database as p_no_charter only', async () => {
    const stub = setup({
      'rpc:book_order_totals': {
        data: { ...totals, filters: { ...totals.filters, charter: null, noCharter: true } },
        error: null,
      },
    });
    expect((await totalsGET(req('?warehouse=all&charter=none&range=today'))).status).toBe(200);
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args.p_no_charter).toBe(true);
    expect(args).not.toHaveProperty('p_charter_id');
    expect(args.p_range).toBe('today');
  });
  it('All charters sends neither charter key (D18)', async () => {
    const stub = setup({ 'rpc:book_order_totals': { data: totals, error: null } });
    expect((await totalsGET(req('?warehouse=all&charter=all'))).status).toBe(200);
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    expect(Object.keys(args).filter((k) => /charter/.test(k))).toEqual([]);
  });
  it.each(['bogus', 'undefined', '123', `${CH_A}x`, ''])(
    'charter=%j is a 400 naming charter, before any read',
    async (bad) => {
      const stub = setup({ 'rpc:book_order_totals': { data: totals, error: null } });
      const res = await totalsGET(req(`?warehouse=all&charter=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
      expect((await res.json()).details).toEqual({ reason: 'invalid_query', keys: ['charter'] });
      expect(stub.rpcCalls).toEqual([]);
    },
  );
  it('a charter the caller may not report on: one 400 with the same body for every cause', async () => {
    const bodies: unknown[] = [];
    for (const id of REFUSED) {
      setup({ 'rpc:book_order_totals': { data: null, error: INVALID_CHARTER } });
      const res = await totalsGET(req(`?warehouse=all&charter=${id}`));
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      bodies.push(await res.json());
    }
    expect(bodies[0]).toEqual({
      error: 'validation_error',
      message: 'That charter is not one you can see.',
      details: { reason: 'invalid_charter' },
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // The id asked for is never echoed back.
    for (const id of REFUSED) expect(JSON.stringify(bodies)).not.toContain(id);
  });
});

describe('GET .../items/[itemId]/orders', () => {
  const params = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
  it('400 for a malformed id or page', async () => {
    setup({});
    expect((await ordersGET(req('/items/x/orders?warehouse=all'), params('x'))).status).toBe(400);
    expect(
      (await ordersGET(req(`/items/${ITEM}/orders?warehouse=all&page=0`), params(ITEM))).status,
    ).toBe(400);
  });
  it("404 for a book outside the caller's scope", async () => {
    setup({
      'rpc:book_order_totals_orders': {
        data: {
          v: 1,
          generatedAt: '2026-09-28T17:42:00+00:00',
          generatedAtLocal: '2026-09-28 10:42',
          found: false,
          book: null,
          range: RANGE,
          statuses: [],
          filters: { warehouse: null },
          totals: { copies: '0', orders: 0, lines: 0, fulfilled: '0', returned: '0' },
          totalCount: 0,
          page: 1,
          pageSize: 25,
          rows: [],
        },
        error: null,
      },
    });
    const res = await ordersGET(req(`/items/${ITEM}/orders?warehouse=${W1}&page=2`), params(ITEM));
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe("This book isn't in your report scope.");
  });
  const ordersAnswer = (filters: Record<string, unknown>) => ({
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    found: true,
    book: {
      itemId: ITEM,
      name: 'Book A',
      sku: 'BK-A',
      identifier: null,
      binLocation: null,
      unit: 'unit',
      countsAsCopies: true,
      warehouseId: W1,
      warehouseName: 'North',
      itemStatus: 'active',
      deleted: false,
      nowRental: false,
    },
    range: RANGE,
    statuses: [],
    filters: { warehouse: null, ...filters },
    totals: { copies: '5', orders: 1, lines: 1, fulfilled: '0', returned: '0' },
    totalCount: 1,
    page: 1,
    pageSize: 25,
    rows: [
      {
        orderId: '0e000000-0000-4000-8000-000000000101',
        orderNumber: 7,
        createdAt: '2026-09-21T03:00:00+00:00',
        orderDate: '2026-09-20',
        status: 'approved',
        warehouseId: W1,
        warehouseName: 'North',
        copies: '5',
        fulfilled: '0',
        returned: '0',
        lines: 1,
        lineIds: ['l1'],
        mine: false,
        charterId: CH_A,
        charterName: 'Charter Alder',
        charterCode: 'CH-A',
      },
    ],
  });
  it('the charter reaches the drill-down; each row names its order charter', async () => {
    const stub = setup({
      'rpc:book_order_totals_orders': {
        data: ordersAnswer({
          charter: { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' },
          noCharter: false,
        }),
        error: null,
      },
    });
    const res = await ordersGET(
      req(
        `/items/${ITEM}/orders?warehouse=all&charter=${CH_A}&range=custom&from=2026-09-01&to=2026-09-30`,
      ),
      params(ITEM),
    );
    expect(res.status).toBe(200);
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args).toMatchObject({
      p_charter_id: CH_A,
      p_range: 'custom',
      p_from_date: '2026-09-01',
      p_to_date: '2026-09-30',
    });
    expect(args).not.toHaveProperty('p_no_charter');
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({
      charterId: CH_A,
      charterName: 'Charter Alder',
      charterCode: 'CH-A',
    });
    expect(body.rows[0]).not.toHaveProperty('mine');
  });
  it('a date-only link (from and to, no range) is a custom range on the drill-down too', async () => {
    const stub = setup({
      'rpc:book_order_totals_orders': { data: ordersAnswer({}), error: null },
    });
    expect(
      (
        await ordersGET(
          req(`/items/${ITEM}/orders?warehouse=all&from=2026-09-01&to=2026-09-30`),
          params(ITEM),
        )
      ).status,
    ).toBe(200);
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_range: 'custom',
      p_from_date: '2026-09-01',
      p_to_date: '2026-09-30',
    });
  });
  it('a refused charter is the same 400 on the drill-down as on the page', async () => {
    setup({ 'rpc:book_order_totals_orders': { data: null, error: INVALID_CHARTER } });
    const drill = await ordersGET(
      req(`/items/${ITEM}/orders?warehouse=all&charter=${REFUSED[0]}`),
      params(ITEM),
    );
    setup({ 'rpc:book_order_totals': { data: null, error: INVALID_CHARTER } });
    const page = await totalsGET(req(`?warehouse=all&charter=${REFUSED[0]}`));
    expect(drill.status).toBe(400);
    expect(await drill.json()).toEqual(await page.json());
  });
  it('a charter answered without its echo (a server before 0382) is an error, never figures', async () => {
    setup({ 'rpc:book_order_totals_orders': { data: ordersAnswer({}), error: null } });
    const res = await ordersGET(
      req(`/items/${ITEM}/orders?warehouse=all&charter=${CH_A}`),
      params(ITEM),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: "Couldn't load Book Order Totals. Try again.",
    });
  });
});

describe('GET .../options', () => {
  it('answers the lists with the organization echoed', async () => {
    setup({
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [],
          categories: [],
          uncategorized: false,
          orderStatusConfig: null,
        },
        error: null,
      },
    });
    const res = await optionsGET(req('/options'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizationId).toBe('org-1');
    expect(body.statusLabels.completed).toBe('Delivered');
  });
  it('answers the charters (id, name, code, status only) and whether No charter applies', async () => {
    setup({
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [],
          categories: [],
          uncategorized: false,
          charters: [{ id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' }],
          noCharter: true,
          orderStatusConfig: null,
        },
        error: null,
      },
    });
    const body = await (await optionsGET(req('/options'))).json();
    expect(body.v).toBe(1);
    expect(body.charters).toEqual([
      { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' },
    ]);
    expect(body.noCharter).toBe(true);
  });
});

describe('GET .../covers', () => {
  it('takes 1 to 25 uuids', async () => {
    setup({});
    const ids = Array.from(
      { length: 26 },
      (_, i) => `0e000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect((await coversGET(req(`/covers?ids=${ids.join(',')}`))).status).toBe(400);
    expect((await coversGET(req('/covers?ids='))).status).toBe(400);
    expect((await coversGET(req('/covers?ids=not-a-uuid'))).status).toBe(400);
  });
  it('answers { organizationId, covers, unresolved } (a hidden book is simply absent)', async () => {
    setup({ 'inventory_items.select': { data: [], error: null } });
    const res = await coversGET(req(`/covers?ids=${ITEM}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: 'org-1', covers: {}, unresolved: [] });
  });
  it('names the books whose cover lookup failed, so the phone never says "No cover" for them', async () => {
    setup({ 'inventory_items.select': { data: null, error: { message: 'timeout' } } });
    const res = await coversGET(req(`/covers?ids=${ITEM}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: 'org-1',
      covers: {},
      unresolved: [ITEM.toLowerCase()],
    });
  });
});
