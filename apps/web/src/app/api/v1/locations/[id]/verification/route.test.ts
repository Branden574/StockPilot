import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODULE_IDS,
  locationRowVerificationCopy,
  locationVerificationTotalsCopy,
  parseItemVerificationSummary,
  type ModuleId,
} from '@stockpilot/core';

import {
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * GET /api/v1/locations/[id]/verification (F1-3) runs the REAL
 * VerificationService over a stubbed client: the location page for the phone.
 * Holdings are read in full (fetchAllRows), summarised in 500-id batches, and
 * totalled across every row while a page of 50 is returned; a location the
 * reader's warehouses do not cover lists nothing and says so; any read that
 * did not complete is a 500 "Couldn't load verification".
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({
      hasAllAccess: true,
      readableIds: [],
      writableIds: [],
    })),
    assertWarehouseAccess: vi.fn(async () => undefined),
  };
});

import { withApiContext } from '@/lib/auth/api-context';

import { GET } from './route';

const LOC = '22222222-2222-4222-8222-222222222222';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function holdings(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `h-${String(i + 1).padStart(6, '0')}`,
    organization_id: 'org-1',
    location_id: LOC,
    item_id: itemId(i + 1),
    quantity: 1,
    item: { id: itemId(i + 1), name: `Item ${String(i + 1).padStart(4, '0')}`, sku: null },
  }));
}

function summaryRow(id: string, countedHere: boolean) {
  return {
    item_id: id,
    item_status: 'active',
    item_is_rental: false,
    item_is_bundle: false,
    item_deleted: false,
    item_countable: true,
    quantity_on_hand: 1,
    cycle_count_id: CC,
    count_number: 31,
    scope: 'selection',
    completed_at: '2026-09-12T16:00:00Z',
    completed_by: 'u-1',
    counted_by: 'u-1',
    counted_at: '2026-09-12T15:02:00Z',
    captured_at: null,
    baseline_at: '2026-09-12T15:02:00Z',
    expected_quantity: 1,
    expected_at_start: 1,
    counted_quantity: 1,
    counted_location_id: countedHere ? LOC : null,
    counted_location_name: countedHere ? 'A-12' : null,
    counted_location_kind: countedHere ? 'rack' : null,
    counted_location_archived: countedHere ? false : null,
    ai_assisted: false,
    movements_since: 0,
    outside_ledger_since: 0,
    open_count_id: null,
    open_count_number: null,
  };
}

function ctxWith(
  o: {
    held?: ReturnType<typeof holdings>;
    visible?: QueryResult;
    rpcCalls?: string[][];
    extra?: Parameters<typeof makeSupabaseStub>[0];
    role?: 'manager' | 'staff' | 'viewer';
    permissions?: string[];
  } = {},
) {
  const held = o.held ?? holdings(3);
  const stub = makeSupabaseStub({
    'locations.select.maybeSingle': {
      data: {
        id: LOC,
        name: 'A-12',
        kind: 'rack',
        type: 'shelf',
        warehouse_id: 'wh-a',
        deleted_at: null,
        warehouse: { name: 'Main' },
      },
      error: null,
    },
    'rpc:location_holdings_visible': o.visible ?? { data: true, error: null },
    'item_stock_levels.select': servedLikePostgrest(held),
    'rpc:item_verification_summaries': (call: MockCall): QueryResult => {
      const ids = (call.args[0]?.[0] as { p_item_ids: string[] }).p_item_ids;
      o.rpcCalls?.push(ids);
      // Odd-numbered items were counted while this was their only shelf location.
      return { data: ids.map((id) => summaryRow(id, Number(id.slice(-4)) % 2 === 1)), error: null };
    },
    'exception_occurrences.select': servedLikePostgrest([]),
    'exception_sync_state.select.maybeSingle': {
      data: { last_synced_at: '2026-09-24T18:00:02Z' },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
    ...o.extra,
  });
  vi.mocked(withApiContext).mockResolvedValueOnce({
    organizationId: 'org-1',
    userId: 'u-1',
    role: o.role ?? 'manager',
    ...(o.permissions ? { permissions: new Set(o.permissions) } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
  } as never);
  return stub;
}

const bearer = (url: string) =>
  new Request(url, { headers: { authorization: 'Bearer token-1' } }) as never;
const cookie = (url: string) =>
  new Request(url, { headers: { cookie: 'sb-x-auth-token=abc' } }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const URL_ = `https://t.local/api/v1/locations/${LOC}/verification`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/locations/[id]/verification', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await GET(bearer(URL_), params(LOC))).status).toBe(401);
  });

  it('serves Bearer and cookie callers alike: the location, a page of rows, and totals', async () => {
    for (const make of [bearer, cookie]) {
      ctxWith();
      const request = make(URL_);
      const res = await GET(request, params(LOC));
      expect(res.status).toBe(200);
      expect(vi.mocked(withApiContext).mock.lastCall?.[0]).toBe(request);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = await res.json();
      expect(body).toMatchObject({
        organizationId: 'org-1',
        location: { id: LOC, name: 'A-12', warehouseName: 'Main', archived: false },
        holdingsVisible: true,
        page: 1,
        pageSize: 50,
        pageCount: 1,
        totalRows: 3,
        canRecount: true,
        recountProblem: null,
        // The phone's "Recount items here" sends these (every countable row).
        recountItemIds: [itemId(1), itemId(2), itemId(3)],
      });
      // The phone words each row with core, through the parser.
      expect(
        body.rows.map(
          (r: { summary: unknown }) =>
            locationRowVerificationCopy(parseItemVerificationSummary(r.summary), LOC, {
              timeZone: body.timeZone,
            }).count,
        ),
      ).toEqual([
        'Counted Sep 12, 2026, while this was its only shelf location',
        'Item total counted Sep 12, 2026, location not recorded',
        'Counted Sep 12, 2026, while this was its only shelf location',
      ]);
    }
  });

  it('holdings past 1000 are all read, summaries go in 500-id batches, and the totals cover every row while the page holds 50', async () => {
    const rpcCalls: string[][] = [];
    const stub = ctxWith({ held: holdings(1201), rpcCalls });
    const res = await GET(bearer(`${URL_}?page=3`), params(LOC));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stub.chainsAll.get('item_stock_levels.select')).toHaveLength(2);
    expect(rpcCalls.map((c) => c.length)).toEqual([500, 500, 201]);
    expect([body.page, body.pageCount, body.totalRows, body.rows.length]).toEqual([
      3, 25, 1201, 50,
    ]);
    expect(body.rows[0].name).toBe('Item 0101');
    expect(body.totals).toMatchObject({
      items: 1201,
      quantity: 1201,
      countedHere: 601,
      countedItemTotal: 600,
    });
    expect(locationVerificationTotalsCopy(body.totals)).toBe(
      '1201 items, 1201 units here. 601 counted while this was their only shelf location, 600 item totals counted.',
    );
  });

  it.each(['0', 'abc', '-1', '1.5', '9999999'])('400 for page=%s', async (page) => {
    const stub = ctxWith();
    const res = await GET(bearer(`${URL_}?page=${page}`), params(LOC));
    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it("a location the reader's warehouses do not cover: 200, nothing listed, holdingsVisible false (never an empty location)", async () => {
    ctxWith({ visible: { data: false, error: null }, role: 'staff' });
    const body = await (await GET(bearer(URL_), params(LOC))).json();
    expect(body.holdingsVisible).toBe(false);
    expect(body.rows).toEqual([]);
    expect(body.totals).toBeNull();
  });

  it('403 without items:read, before any read', async () => {
    const stub = ctxWith({ role: 'viewer', permissions: ['members:read', 'locations:read'] });
    const res = await GET(bearer(URL_), params(LOC));
    expect(res.status).toBe(403);
    expect(stub.fromCalls).toHaveLength(0);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it("404 for a location not in the reader's organization; 400 for a malformed id", async () => {
    ctxWith({ extra: { 'locations.select.maybeSingle': { data: null, error: null } } });
    expect((await GET(bearer(URL_), params(LOC))).status).toBe(404);
    ctxWith();
    expect(
      (await GET(bearer('https://t.local/api/v1/locations/x/verification'), params('x'))).status,
    ).toBe(400);
  });

  it.each([
    ['the holdings', { 'item_stock_levels.select': { data: null, error: { message: 'boom' } } }],
    [
      'the summaries',
      { 'rpc:item_verification_summaries': { data: null, error: { message: 'boom' } } },
    ],
    [
      'the scope check',
      { 'rpc:location_holdings_visible': { data: null, error: { message: 'boom' } } },
    ],
    [
      'the open exceptions',
      { 'exception_occurrences.select': { data: null, error: { message: 'boom' } } },
    ],
  ])(
    'a failed read of %s is a 500 "Couldn\'t load verification", never an empty location',
    async (_what, extra) => {
      ctxWith({ extra: extra as Parameters<typeof makeSupabaseStub>[0] });
      const res = await GET(bearer(URL_), params(LOC));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'internal_error',
        message: "Couldn't load verification",
      });
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'api.v1.locations.verification' }),
      );
    },
  );
});
