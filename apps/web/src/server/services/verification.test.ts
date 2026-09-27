import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, verificationSummaryCopy, type ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * VerificationService (F1-3): what the item card, the location page and the
 * phone's two routes read. Everything goes through the reader's own client;
 * item_verification_summaries is called in batches of at most 500 ids; every
 * read that feeds the words throws on failure (the page then says "Couldn't
 * load verification"), and none of them is ever turned into an empty answer.
 */

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

import { ServiceError } from './context';
import {
  LOCATION_HOLDINGS_CAP,
  LOCATION_VERIFICATION_PAGE_SIZE,
  mapSummaryRow,
  VERIFICATION_BATCH_SIZE,
  VerificationService,
  type SummaryRow,
} from './verification';

const ORG = 'org-1';
const ITEM = '11111111-1111-4111-8111-111111111111';
const LOC = '22222222-2222-4222-8222-222222222222';
const OTHER_LOC = '33333333-3333-4333-8333-333333333333';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPEN_CC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** A deterministic uuid for the n-th item. */
function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(id: string, o: Partial<SummaryRow> = {}): SummaryRow {
  return {
    item_id: id,
    item_status: 'active',
    item_is_rental: false,
    item_is_bundle: false,
    item_deleted: false,
    item_countable: true,
    quantity_on_hand: 12,
    cycle_count_id: CC,
    count_number: 31,
    scope: 'selection',
    completed_at: '2026-09-12T16:00:00Z',
    completed_by: 'u-post',
    counted_by: 'u-count',
    counted_at: '2026-09-12T15:02:00Z',
    captured_at: null,
    baseline_at: '2026-09-12T15:02:00Z',
    expected_quantity: 10,
    expected_at_start: 10,
    counted_quantity: 10,
    counted_location_id: null,
    counted_location_name: null,
    counted_location_kind: null,
    counted_location_archived: null,
    ai_assisted: false,
    movements_since: 2,
    outside_ledger_since: 0,
    open_count_id: null,
    open_count_number: null,
    ...o,
  };
}

function neverRow(id: string, o: Partial<SummaryRow> = {}): SummaryRow {
  return row(id, {
    cycle_count_id: null,
    count_number: null,
    scope: null,
    completed_at: null,
    completed_by: null,
    counted_by: null,
    counted_at: null,
    baseline_at: null,
    expected_quantity: null,
    expected_at_start: null,
    counted_quantity: null,
    movements_since: null,
    outside_ledger_since: null,
    ...o,
  });
}

/** An rpc result that answers item_verification_summaries per call, from a
 *  row per known item (the ids the call asked for, in its org). */
function summariesRpc(rows: Map<string, SummaryRow>, calls: string[][] = []) {
  return (call: MockCall): QueryResult => {
    const args = call.args[0]?.[0] as { p_org: string; p_item_ids: string[] };
    calls.push(args.p_item_ids);
    if (args.p_item_ids.length > 500)
      return { data: null, error: { message: 'too_many_items', code: '22023' } };
    return {
      data: args.p_item_ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
      error: null,
    };
  };
}

function ctx(
  stub: ReturnType<typeof makeSupabaseStub>,
  o: Parameters<typeof makeServiceContext>[1] = {},
) {
  return makeServiceContext(stub.client, { organizationId: ORG, role: 'manager', ...o });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mapSummaryRow', () => {
  it('a never-counted row has no last count and UNKNOWN movements, whatever the numbers say', () => {
    const s = mapSummaryRow(neverRow(ITEM, { movements_since: 0, outside_ledger_since: 0 }));
    expect(s.lastCount).toBeNull();
    expect(s.movementsSince).toBeNull();
    expect(s.outsideLedgerSince).toBeNull();
    expect(verificationSummaryCopy(s).headline).toBe('No physical count on record.');
  });

  it('maps a counted row, reading numeric strings, with people unnamed until the item read names them', () => {
    const s = mapSummaryRow(
      row(ITEM, {
        count_number: '31',
        expected_quantity: '8.0000',
        counted_quantity: '10.0000',
        quantity_on_hand: '12.5000',
        counted_location_id: LOC,
        counted_location_name: 'A-12',
        counted_location_kind: 'rack',
        counted_location_archived: false,
        movements_since: 3,
        outside_ledger_since: 1,
        open_count_id: OPEN_CC,
        open_count_number: '45',
        ai_assisted: true,
      }),
    );
    expect(s).toEqual({
      itemId: ITEM,
      item: {
        status: 'active',
        isRental: false,
        isBundle: false,
        deleted: false,
        countable: true,
        quantityOnHand: 12.5,
      },
      lastCount: {
        cycleCountId: CC,
        countNumber: 31,
        completedAt: '2026-09-12T16:00:00Z',
        countedAt: '2026-09-12T15:02:00Z',
        capturedAt: null,
        baselineAt: '2026-09-12T15:02:00Z',
        expectedQuantity: 8,
        expectedAtStart: 10,
        countedQuantity: 10,
        countedLocationId: LOC,
        countedLocation: { name: 'A-12', kind: 'rack', archived: false },
        aiAssisted: true,
        countedBy: { id: 'u-count', label: null },
        postedBy: { id: 'u-post', label: null },
      },
      movementsSince: 3,
      outsideLedgerSince: 1,
      openCount: { cycleCountId: OPEN_CC, countNumber: 45 },
    });
  });
});

describe('VerificationService.summaries', () => {
  it(`calls item_verification_summaries in batches of ${VERIFICATION_BATCH_SIZE} ids (deduped), as the reader`, async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => itemId(i + 1));
    const rows = new Map(ids.map((id) => [id, row(id)]));
    const calls: string[][] = [];
    const stub = makeSupabaseStub({ 'rpc:item_verification_summaries': summariesRpc(rows, calls) });
    const out = await new VerificationService(ctx(stub)).summaries([...ids, ids[0]!, ids[5]!]);
    expect(calls.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(new Set(calls.flat()).size).toBe(1201);
    expect(out.size).toBe(1201);
    expect(stub.rpcCalls.every((c) => (c.args as { p_org: string }).p_org === ORG)).toBe(true);
  });

  it('an item the reader cannot read is simply absent (the function returned no row for it)', async () => {
    const stub = makeSupabaseStub({
      'rpc:item_verification_summaries': summariesRpc(new Map([[ITEM, row(ITEM)]])),
    });
    const out = await new VerificationService(ctx(stub)).summaries([ITEM, itemId(9)]);
    expect([...out.keys()]).toEqual([ITEM]);
  });

  it('any failed batch fails the whole read: never a partial map', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => itemId(i + 1));
    let n = 0;
    const stub = makeSupabaseStub({
      'rpc:item_verification_summaries': (call) => {
        n += 1;
        if (n === 2) return { data: null, error: { message: 'boom' } };
        return summariesRpc(new Map(ids.map((id) => [id, row(id)])))(call);
      },
    });
    await expect(new VerificationService(ctx(stub)).summaries(ids)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('a non-array answer is a failure, not "no rows"', async () => {
    const stub = makeSupabaseStub({
      'rpc:item_verification_summaries': { data: null, error: null },
    });
    await expect(new VerificationService(ctx(stub)).summaries([ITEM])).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('needs items:read, and the MFA step-up first', async () => {
    const stub = makeSupabaseStub({});
    await expect(
      new VerificationService(
        ctx(stub, { role: 'viewer', permissions: new Set(['members:read']) }),
      ).summaries([ITEM]),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      new VerificationService(ctx(stub, { mfaRequired: true, mfaSatisfied: false })).summaries([
        ITEM,
      ]),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'mfa_required' } });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});

function itemStub(
  o: {
    summary?: SummaryRow | null;
    issues?: QueryResult | ((call: MockCall) => QueryResult);
    sync?: QueryResult;
    profiles?: QueryResult;
    rpcError?: boolean;
  } = {},
) {
  const rows = new Map<string, SummaryRow>();
  if (o.summary !== null) rows.set(ITEM, o.summary ?? row(ITEM));
  return makeSupabaseStub({
    'rpc:item_verification_summaries': o.rpcError
      ? { data: null, error: { message: 'statement timeout', code: '57014' } }
      : summariesRpc(rows),
    'exception_occurrences.select':
      o.issues ??
      servedLikePostgrest([
        {
          id: 'o-1',
          organization_id: ORG,
          occurrence_number: 42,
          rule: 'count_variance',
          item_id: ITEM,
          location_id: null,
          resolved_at: null,
        },
        {
          id: 'o-2',
          organization_id: ORG,
          occurrence_number: 43,
          rule: 'stale_staging',
          item_id: ITEM,
          location_id: LOC,
          resolved_at: null,
        },
        {
          id: 'o-3',
          organization_id: ORG,
          occurrence_number: 7,
          rule: 'count_variance',
          item_id: ITEM,
          location_id: null,
          resolved_at: '2026-09-01T00:00:00Z',
        },
        {
          id: 'o-4',
          organization_id: ORG,
          occurrence_number: 44,
          rule: 'over_reserved',
          item_id: itemId(2),
          location_id: null,
          resolved_at: null,
        },
      ]),
    'exception_sync_state.select.maybeSingle': o.sync ?? {
      data: { last_synced_at: '2026-09-24T18:00:02Z' },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
    'user_profiles.select': o.profiles ?? {
      data: [
        { id: 'u-count', full_name: 'Avery Count', email: 'a@x' },
        { id: 'u-post', full_name: null, email: 'blake@x' },
      ],
      error: null,
    },
  });
}

describe('VerificationService.item', () => {
  it("the summary with named people, the item's open exceptions (any location, open only), checked-at and time zone", async () => {
    const stub = itemStub();
    const r = await new VerificationService(ctx(stub)).item(ITEM);
    expect(r.itemId).toBe(ITEM);
    expect(r.summary.lastCount?.countedBy).toEqual({ id: 'u-count', label: 'Avery Count' });
    expect(r.summary.lastCount?.postedBy).toEqual({ id: 'u-post', label: 'blake@x' });
    expect(r.openIssues.map((i) => [i.reference, i.rule, i.locationId])).toEqual([
      ['EX-000042', 'count_variance', null],
      ['EX-000043', 'stale_staging', LOC],
    ]);
    expect(r.openIssuesTruncated).toBe(false);
    expect(r.checkedAt).toBe('2026-09-24T18:00:02Z');
    expect(r.timeZone).toBe('America/Chicago');
    expect(verificationSummaryCopy(r.summary, { timeZone: r.timeZone }).who).toBe(
      'Counted by Avery Count, posted by blake@x.',
    );
    // Every read is pinned to the org.
    const issuesChain = stub.chainArgsAll.get('exception_occurrences.select')![0]!;
    expect(issuesChain).toContainEqual(['organization_id', ORG]);
  });

  it('a profile the reader cannot see is a former member', async () => {
    const stub = itemStub({
      profiles: { data: [{ id: 'u-count', full_name: 'Avery', email: null }], error: null },
    });
    const r = await new VerificationService(ctx(stub)).item(ITEM);
    expect(r.summary.lastCount?.postedBy).toEqual({ id: 'u-post', label: 'Former member' });
  });

  it('a failed profile read leaves the names out (never "Former member"), reported as degraded', async () => {
    const stub = itemStub({ profiles: { data: null, error: { message: 'boom' } } });
    const r = await new VerificationService(ctx(stub)).item(ITEM);
    expect(r.summary.lastCount?.countedBy).toEqual({ id: 'u-count', label: null });
    expect(verificationSummaryCopy(r.summary).who).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'verification.count_people_unavailable', level: 'warning' }),
    );
  });

  it('a never-counted item is a stated answer, and reads no profiles', async () => {
    const stub = itemStub({ summary: neverRow(ITEM) });
    const r = await new VerificationService(ctx(stub)).item(ITEM);
    expect(r.summary.lastCount).toBeNull();
    expect(stub.fromCalls).not.toContain('user_profiles');
  });

  it('not_found when the reader cannot read the item (no row), never a never-counted answer', async () => {
    const stub = itemStub({ summary: null });
    await expect(new VerificationService(ctx(stub)).item(ITEM)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a malformed id is a validation error before any read', async () => {
    const stub = itemStub();
    await expect(new VerificationService(ctx(stub)).item('nope')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it.each([
    ['the summary', { rpcError: true }],
    ['the open exceptions', { issues: { data: null, error: { message: 'boom' } } }],
    ['the checked-at', { sync: { data: null, error: { message: 'boom' } } }],
  ] as const)(
    'a failed read of %s throws (the card says "Couldn\'t load verification")',
    async (_what, o) => {
      const stub = itemStub(o as Parameters<typeof itemStub>[0]);
      const err = await new VerificationService(ctx(stub)).item(ITEM).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('internal_error');
    },
  );

  it('checkedAt is null before the org\'s first check (never read as "no issues")', async () => {
    const stub = itemStub({ sync: { data: null, error: null } });
    expect((await new VerificationService(ctx(stub)).item(ITEM)).checkedAt).toBeNull();
  });

  it('canCount: a manager with Cycle Counts on; staff, a viewer, or Cycle Counts off say why not', async () => {
    const mgr = await new VerificationService(ctx(itemStub())).item(ITEM);
    expect([mgr.canCount, mgr.countUnavailableReason]).toEqual([true, null]);
    const staff = await new VerificationService(ctx(itemStub(), { role: 'staff' })).item(ITEM);
    expect([staff.canCount, staff.countUnavailableReason]).toEqual([false, 'not_permitted']);
    const off = new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'cycle_counts'));
    const noModule = await new VerificationService(ctx(itemStub(), { enabledModules: off })).item(
      ITEM,
    );
    expect([noModule.canCount, noModule.countUnavailableReason]).toEqual([
      false,
      'module_disabled',
    ]);
  });
});

// ── The location page ───────────────────────────────────────────────────────

type Holding = {
  id: string;
  organization_id: string;
  location_id: string;
  item_id: string;
  quantity: number;
  item: { id: string; name: string; sku: string | null } | null;
};

function holdings(n: number, o: { hidden?: number[] } = {}): Holding[] {
  return Array.from({ length: n }, (_, i) => {
    const id = itemId(i + 1);
    return {
      id: `h-${String(i + 1).padStart(6, '0')}`,
      organization_id: ORG,
      location_id: LOC,
      item_id: id,
      quantity: 2,
      item: o.hidden?.includes(i + 1)
        ? null
        : { id, name: `Item ${String(i + 1).padStart(4, '0')}`, sku: `SKU-${i + 1}` },
    };
  });
}

function locationStub(
  o: {
    held?: Holding[];
    visible?: QueryResult;
    location?: QueryResult;
    summaryRows?: Map<string, SummaryRow>;
    summaryCalls?: string[][];
    issues?: Array<Record<string, unknown>>;
  } = {},
) {
  const held = o.held ?? holdings(3);
  const rows = o.summaryRows ?? new Map(held.map((h) => [h.item_id, row(h.item_id)]));
  return makeSupabaseStub({
    'locations.select.maybeSingle': o.location ?? {
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
    'rpc:item_verification_summaries': summariesRpc(rows, o.summaryCalls ?? []),
    'exception_occurrences.select': servedLikePostgrest(
      (o.issues ?? []).map((r) => ({ organization_id: ORG, resolved_at: null, ...r })),
    ),
    'exception_sync_state.select.maybeSingle': {
      data: { last_synced_at: '2026-09-24T18:00:02Z' },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
  });
}

describe('VerificationService.location', () => {
  it('the location, its rows by name with summaries, and totals', async () => {
    const stub = locationStub({
      summaryRows: new Map([
        [itemId(1), row(itemId(1), { counted_location_id: LOC })],
        [itemId(2), neverRow(itemId(2))],
        [itemId(3), row(itemId(3))],
      ]),
    });
    const r = await new VerificationService(ctx(stub)).location(LOC);
    expect(r.location).toEqual({
      id: LOC,
      name: 'A-12',
      kind: 'rack',
      type: 'shelf',
      warehouseId: 'wh-a',
      warehouseName: 'Main',
      archived: false,
    });
    expect(r.holdingsVisible).toBe(true);
    expect(
      r.rows.map((x) => [x.name, x.quantity, x.summary?.lastCount?.cycleCountId ?? null]),
    ).toEqual([
      ['Item 0001', 2, CC],
      ['Item 0002', 2, null],
      ['Item 0003', 2, CC],
    ]);
    expect(r.totals).toMatchObject({
      items: 3,
      quantity: 6,
      countedHere: 1,
      countedItemTotal: 1,
      notCounted: 1,
      unavailable: 0,
    });
    expect([r.page, r.pageCount, r.totalRows, r.pageSize]).toEqual([
      1,
      1,
      3,
      LOCATION_VERIFICATION_PAGE_SIZE,
    ]);
    expect(r.truncated).toBe(false);
    // Holdings are read for this org and location, positive only.
    const chain = stub.chainArgsAll.get('item_stock_levels.select')![0]!;
    expect(chain).toContainEqual(['organization_id', ORG]);
    expect(chain).toContainEqual(['location_id', LOC]);
    expect(chain).toContainEqual(['quantity', 0]);
    expect(stub.rpcCalls.find((c) => c.name === 'location_holdings_visible')?.args).toEqual({
      p_location_id: LOC,
    });
  });

  it('reads EVERY holding (fetchAllRows past 1000), summarises them in 500-id batches, and totals cover all rows while the page shows 50', async () => {
    const held = holdings(1234);
    const calls: string[][] = [];
    const stub = locationStub({ held, summaryCalls: calls });
    const r = await new VerificationService(ctx(stub)).location(LOC, { page: 2 });
    // Two holdings pages (1000 + 234).
    expect(stub.chainsAll.get('item_stock_levels.select')).toHaveLength(2);
    expect(calls.map((c) => c.length)).toEqual([500, 500, 234]);
    expect(r.totalRows).toBe(1234);
    expect(r.pageCount).toBe(25);
    expect(r.page).toBe(2);
    expect(r.rows).toHaveLength(50);
    expect(r.rows[0]!.name).toBe('Item 0051');
    expect(r.totals).toMatchObject({
      items: 1234,
      quantity: 2468,
      countedItemTotal: 1234,
      countable: 1234,
    });
    // More than the recount cap: "Recount items here" says why not.
    expect(r.recountProblem).toMatch(/at most 200 items/);
  });

  it('a page past the end answers the last page; page 1 by default', async () => {
    const stub = locationStub({ held: holdings(60) });
    const last = await new VerificationService(ctx(stub)).location(LOC, { page: 9 });
    expect([last.page, last.rows.length]).toEqual([2, 10]);
    const first = await new VerificationService(ctx(locationStub({ held: holdings(60) }))).location(
      LOC,
    );
    expect([first.page, first.rows.length]).toEqual([1, 50]);
  });

  it('holdings of items the reader cannot open are counted as hidden, not listed and not summarised', async () => {
    const calls: string[][] = [];
    const stub = locationStub({ held: holdings(4, { hidden: [2, 4] }), summaryCalls: calls });
    const r = await new VerificationService(ctx(stub)).location(LOC);
    expect(r.rows.map((x) => x.itemId)).toEqual([itemId(1), itemId(3)]);
    expect(r.totals).toMatchObject({ items: 2, quantity: 4, hiddenItems: 2, hiddenQuantity: 4 });
    expect(calls.flat().sort()).toEqual([itemId(1), itemId(3)]);
  });

  it('a row whose summary did not come back reads as unavailable, never "Not counted"', async () => {
    const stub = locationStub({
      held: holdings(2),
      summaryRows: new Map([[itemId(1), row(itemId(1))]]),
    });
    const r = await new VerificationService(ctx(stub)).location(LOC);
    expect(r.rows[1]!.summary).toBeNull();
    expect(r.totals).toMatchObject({ unavailable: 1, notCounted: 0 });
  });

  it("when the reader's warehouses do not cover the location: nothing listed, holdingsVisible false, no totals", async () => {
    const stub = locationStub({ visible: { data: false, error: null } });
    const r = await new VerificationService(ctx(stub, { role: 'staff' })).location(LOC);
    expect(r.holdingsVisible).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.totals).toBeNull();
    expect(stub.rpcCalls.filter((c) => c.name === 'item_verification_summaries')).toHaveLength(0);
  });

  it("open issues here (this location) and each row's chips (here, or about the item itself; not elsewhere)", async () => {
    const stub = locationStub({
      held: holdings(2),
      issues: [
        {
          id: 'o-1',
          occurrence_number: 1,
          rule: 'stale_staging',
          item_id: itemId(1),
          location_id: LOC,
        },
        {
          id: 'o-2',
          occurrence_number: 2,
          rule: 'count_variance',
          item_id: itemId(1),
          location_id: null,
        },
        {
          id: 'o-3',
          occurrence_number: 3,
          rule: 'long_unplaced',
          item_id: itemId(2),
          location_id: OTHER_LOC,
        },
        {
          id: 'o-4',
          occurrence_number: 4,
          rule: 'orphaned_stock',
          item_id: itemId(9),
          location_id: LOC,
        },
      ],
    });
    const r = await new VerificationService(ctx(stub)).location(LOC);
    expect(r.openIssues.map((i) => i.reference)).toEqual(['EX-000001', 'EX-000004']);
    expect(r.rows[0]!.issues.map((i) => i.reference)).toEqual(['EX-000001', 'EX-000002']);
    expect(r.rows[1]!.issues).toEqual([]);
  });

  it('not_found for a location outside the org or unknown; a malformed id is a validation error', async () => {
    const stub = locationStub({ location: { data: null, error: null } });
    await expect(new VerificationService(ctx(stub)).location(LOC)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(new VerificationService(ctx(locationStub())).location('x')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it.each([
    ['the location', { location: { data: null, error: { message: 'boom' } } }],
    ['the scope check', { visible: { data: null, error: { message: 'boom' } } }],
    ['a scope answer that is not a boolean', { visible: { data: null, error: null } }],
  ] as const)('a failed read of %s throws, never an empty page', async (_what, o) => {
    const stub = locationStub(o as Parameters<typeof locationStub>[0]);
    await expect(new VerificationService(ctx(stub)).location(LOC)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('a failed holdings page throws (never a short list read as the whole location)', async () => {
    const held = holdings(1500);
    const stub = makeSupabaseStub({
      'locations.select.maybeSingle': {
        data: {
          id: LOC,
          name: 'A-12',
          kind: 'rack',
          type: 'shelf',
          warehouse_id: null,
          deleted_at: null,
        },
        error: null,
      },
      'rpc:location_holdings_visible': { data: true, error: null },
      'item_stock_levels.select': (call) => {
        const range = call.args[call.methods.indexOf('range')] as [number, number];
        return range[0] === 0
          ? servedLikePostgrest(held)(call)
          : { data: null, error: { message: 'boom' } };
      },
      'exception_sync_state.select.maybeSingle': { data: null, error: null },
    });
    await expect(new VerificationService(ctx(stub)).location(LOC)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it(`reaching the ${LOCATION_HOLDINGS_CAP}-holding cap is disclosed`, async () => {
    const stub = locationStub({ held: holdings(LOCATION_HOLDINGS_CAP + 5) });
    const r = await new VerificationService(ctx(stub)).location(LOC);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(LOCATION_HOLDINGS_CAP);
  }, 30_000);

  it('canRecount for a manager with Cycle Counts on, and the recount problem only speaks to the item count', async () => {
    const mgr = await new VerificationService(ctx(locationStub())).location(LOC);
    expect([mgr.canRecount, mgr.recountUnavailableReason, mgr.recountProblem]).toEqual([
      true,
      null,
      null,
    ]);
    const staff = await new VerificationService(ctx(locationStub(), { role: 'staff' })).location(
      LOC,
    );
    expect([staff.canRecount, staff.recountUnavailableReason]).toEqual([false, 'not_permitted']);
    const rentalsOnly = locationStub({
      held: holdings(1),
      summaryRows: new Map([
        [itemId(1), row(itemId(1), { item_is_rental: true, item_countable: false })],
      ]),
    });
    expect((await new VerificationService(ctx(rentalsOnly)).location(LOC)).recountProblem).toBe(
      'Nothing here can be counted.',
    );
  });
});
