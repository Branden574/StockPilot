import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * Count differences, R2 (migration 0386): "Confirm this count" in the
 * service. The countConfirm block on an open count_variance detail (core
 * countConfirmState, then countConfirmGate, from three reads: the item's
 * summary, the item's lines in counts that are in progress, and the identity
 * history), confirmCount (the app gate against the item's live warehouse,
 * the RPC's answers by SQLSTATE and hint, one audit row per confirm that is
 * not a replay), the confirmation on list and detail rows, the Resolved
 * list's "closed without a second count" filter, and the D6 switch.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));

const access = vi.hoisted(() => ({
  value: { hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] } as {
    hasAllAccess: boolean;
    readableIds: string[];
    writableIds: string[];
  },
}));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => access.value),
    assertWarehouseAccess: vi.fn(async (wh: string, op: string, ctx: { role: string }) => {
      if (op === 'write' && ctx.role === 'viewer') throw new ForbiddenError('viewer');
      if (!access.value.hasAllAccess && !access.value.writableIds.includes(wh)) {
        throw new ForbiddenError('no write');
      }
    }),
  };
});

import { audit } from './audit';
import {
  EXCEPTION_COUNT_CONFIRM_ENABLED,
  ExceptionOccurrencesService,
  mapConfirmError,
} from './exception-occurrences';

const auditMock = vi.mocked(audit);

const ORG = 'org-1';
const OCC = '11111111-1111-4111-8111-111111111111';
const CC = '22222222-2222-4222-8222-222222222222';
const CC_NEW = '33333333-3333-4333-8333-333333333333';
const CC_OTHER = '44444444-4444-4444-8444-444444444444';
const RECOUNT = '55555555-5555-4555-8555-555555555555';
const STAFF = 'u-staff';
const STAFF_B = 'u-staff-b';
const MGR = 'u-mgr';

const SYNC_ROW = {
  tracking_started_at: '2026-09-24T15:00:00Z',
  last_evaluated_at: '2026-09-29T18:00:00Z',
  last_synced_at: '2026-09-29T18:00:02Z',
  complete_rules: ['count_variance'],
  failed_rules: [],
  truncated_rules: [],
};

const FACTS = { itemName: 'Umbrella', sku: 'U1', cycleCountId: CC, countNumber: 35, expected: 100, counted: 2, variance: -98 };

/** An open count difference: CC-000035 found 2 where 100 was on record. */
function cvRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 59,
    rule: 'count_variance',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: FACTS,
    condition_since: '2026-09-29T17:00:00Z',
    first_seen_at: '2026-09-29T17:01:00Z',
    last_seen_at: '2026-09-29T18:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    confirmed_at: null,
    confirmed_by: null,
    confirmed_cycle_count_id: null,
    confirmed_quantity: null,
    confirmed_as: null,
    item: { name: 'Umbrella (live)', sku: 'U1', warehouse_id: 'wh-a' },
    location: null,
    recount: null,
    acknowledger: null,
    confirmer: null,
    confirmed_count: null,
    ...o,
  };
}

/** item_verification_summaries' row for the item (the Physical count card's read). */
function summaryRow(o: Record<string, unknown> = {}) {
  return {
    item_id: 'item-1',
    item_status: 'active',
    item_is_rental: false,
    item_is_bundle: false,
    item_deleted: false,
    item_countable: true,
    quantity_on_hand: 2,
    cycle_count_id: CC,
    count_number: 35,
    scope: 'selection',
    completed_at: '2026-09-29T17:00:00Z',
    completed_by: MGR,
    counted_by: STAFF,
    counted_at: '2026-09-29T16:59:00Z',
    captured_at: null,
    baseline_at: '2026-09-29T16:59:00Z',
    expected_quantity: 100,
    expected_at_start: 100,
    counted_quantity: 2,
    counted_location_id: null,
    counted_location_name: null,
    counted_location_kind: null,
    counted_location_archived: null,
    ai_assisted: false,
    movements_since: 0,
    outside_ledger_since: 0,
    open_count_id: null,
    open_count_number: null,
    ...o,
  };
}

const PROFILES = [
  { id: STAFF, full_name: 'Dana Lee', email: 'dana@x' },
  { id: MGR, full_name: 'Sam Ortiz', email: 'sam@x' },
];

type Results = NonNullable<Parameters<typeof makeSupabaseStub>[0]>;

function detailResults(o: {
  row?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  summaryError?: boolean;
  lines?: Array<Record<string, unknown>>;
  linesError?: boolean;
  history?: Array<Record<string, unknown>>;
  extra?: Results;
} = {}): Results {
  return {
    'exception_occurrences.select.maybeSingle': { data: cvRow(o.row), error: null },
    'exception_occurrence_events.select': { data: [], error: null },
    'exception_occurrences.select': {
      data: o.history ?? [
        { id: OCC, occurrence_number: 59, first_seen_at: '2026-09-29T17:01:00Z', resolved_at: null, resolved_reason: null, recurrence_index: 0, confirmed_as: null, confirmed_cycle_count_id: null },
      ],
      error: null,
    },
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    'rpc:item_verification_summaries': o.summaryError
      ? { data: null, error: { message: 'summaries timed out', code: '57014' } }
      : { data: o.summary === null ? [] : [summaryRow(o.summary ?? {})], error: null },
    'user_profiles.select': { data: PROFILES, error: null },
    'cycle_count_lines.select': o.linesError
      ? { data: null, error: { message: 'lines read failed' } }
      : { data: o.lines ?? [], error: null },
    ...(o.extra ?? {}),
  };
}

function svcFor(
  results: Results,
  who: { role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer'; userId?: string } = {},
  opts: { countConfirmEnabled?: boolean } = {},
) {
  const stub = makeSupabaseStub(results);
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG,
    role: who.role ?? 'staff',
    userId: who.userId ?? STAFF,
  });
  // Confirm ON unless a test says otherwise, whatever the constant is, so
  // this suite passes both with Confirm on and after the revert kit's
  // forward commit turns it off (only the constant's own test flips).
  return {
    svc: new ExceptionOccurrencesService(ctx as never, { countConfirmEnabled: opts.countConfirmEnabled ?? true }),
    stub,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.value = { hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] };
});

// ═══════════════════════════════════════════════════════════════════════════
// D6
// ═══════════════════════════════════════════════════════════════════════════

describe('D6: EXCEPTION_COUNT_CONFIRM_ENABLED', () => {
  it('is on in this release (the revert turns it off by a forward commit)', () => {
    expect(EXCEPTION_COUNT_CONFIRM_ENABLED).toBe(true);
  });

  it('a service built without the option follows the constant', async () => {
    const stub = makeSupabaseStub(detailResults());
    const ctx = makeServiceContext(stub.client, { organizationId: ORG, role: 'staff', userId: STAFF });
    const d = await new ExceptionOccurrencesService(ctx as never).get(OCC);
    expect(d.countConfirm !== null).toBe(EXCEPTION_COUNT_CONFIRM_ENABLED);
  });

  it('off: no countConfirm block and none of its reads', async () => {
    const { svc, stub } = svcFor(detailResults(), {}, { countConfirmEnabled: false });
    const d = await svc.get(OCC);
    expect(d.countConfirm).toBeNull();
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('item_verification_summaries');
    expect(stub.fromCalls).not.toContain('cycle_count_lines');
  });

  it('off: confirmCount refuses with unavailable before the RPC and before any read', async () => {
    const { svc, stub } = svcFor(detailResults(), {}, { countConfirmEnabled: false });
    await expect(svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'unavailable' },
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The countConfirm block
// ═══════════════════════════════════════════════════════════════════════════

describe('get: the countConfirm block', () => {
  it('the counter sees a confirmable count with every number and both people named', async () => {
    const { svc, stub } = svcFor(detailResults());
    const d = await svc.get(OCC);
    expect(d.countConfirm).toEqual({
      state: 'confirmable',
      canConfirm: true,
      unavailableReason: null,
      cycleCountId: CC,
      countNumber: 35,
      counted: 2,
      onRecordBefore: 100,
      onRecordNow: 2,
      countedBy: { id: STAFF, label: 'Dana Lee' },
      postedBy: { id: MGR, label: 'Sam Ortiz' },
      readerIsCounter: true,
      otherCount: null,
    });
    // One summaries read for the one item, through the reader's own client.
    expect(stub.rpcCalls.filter((c) => c.name === 'item_verification_summaries')).toEqual([
      { name: 'item_verification_summaries', args: { p_org: ORG, p_item_ids: ['item-1'] } },
    ]);
  });

  it('reads the item\'s lines in counts in progress, for this org, with the re-check field', async () => {
    const { svc, stub } = svcFor(detailResults());
    await svc.get(OCC);
    const chain = stub.chainsAll.get('cycle_count_lines.select')![0]!;
    const args = stub.chainArgsAll.get('cycle_count_lines.select')![0]!;
    expect(String(args[chain.indexOf('select')]![0])).toContain('rechecks:cycle_count_line_rechecks');
    expect(String(args[chain.indexOf('select')]![0])).toContain('count:cycle_counts!inner(');
    const eqs = chain.flatMap((m, i) => (m === 'eq' ? [args[i]] : []));
    expect(eqs).toEqual([
      ['item_id', 'item-1'],
      ['count.status', 'in_progress'],
      ['count.organization_id', ORG],
    ]);
  });

  it('staff who did not count: withheld with not_counter, the counter named', async () => {
    const { svc } = svcFor(detailResults(), { userId: STAFF_B });
    const c = (await svc.get(OCC)).countConfirm!;
    expect(c).toMatchObject({ state: 'confirmable', canConfirm: false, unavailableReason: 'not_counter', readerIsCounter: false });
    expect(c.countedBy).toEqual({ id: STAFF, label: 'Dana Lee' });
  });

  it('a manager who did not count: offered', async () => {
    const { svc } = svcFor(detailResults(), { role: 'manager', userId: MGR });
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ canConfirm: true, readerIsCounter: false });
  });

  it('a viewer: not_permitted (the act gate first)', async () => {
    const { svc } = svcFor(detailResults(), { role: 'viewer', userId: 'u-viewer' });
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ canConfirm: false, unavailableReason: 'not_permitted' });
  });

  it('the act gate is judged against the ITEM\'s live warehouse, not the row\'s stamp', async () => {
    // The item moved to wh-b (not writable) while the stamp still says wh-a.
    const moved = svcFor(detailResults({ row: { item: { name: 'U', sku: 'U1', warehouse_id: 'wh-b' } } }));
    expect((await moved.svc.get(OCC)).countConfirm).toMatchObject({ canConfirm: false, unavailableReason: 'not_permitted' });
    // The item moved INTO wh-a while the stamp still says wh-b.
    const into = svcFor(detailResults({ row: { warehouse_id: 'wh-b' } }));
    expect((await into.svc.get(OCC)).countConfirm).toMatchObject({ canConfirm: true });
  });

  it('count_in_progress: another open count recorded a different number; it is named with its number', async () => {
    const { svc } = svcFor(
      detailResults({
        lines: [
          { id: 'l1', cycle_count_id: CC_OTHER, counted_quantity: 3, expected_quantity: 2, rechecks: true, count: { count_number: 41, status: 'in_progress', organization_id: ORG } },
        ],
      }),
    );
    expect((await svc.get(OCC)).countConfirm).toMatchObject({
      state: 'count_in_progress',
      canConfirm: false,
      unavailableReason: 'count_in_progress',
      otherCount: { countNumber: 41, counted: 3 },
    });
  });

  it('an uncounted line, a matching one, or one that can no longer re-check the item does not block', async () => {
    const { svc } = svcFor(
      detailResults({
        lines: [
          { id: 'l1', cycle_count_id: CC_OTHER, counted_quantity: null, expected_quantity: 2, rechecks: true, count: { count_number: 41, status: 'in_progress', organization_id: ORG } },
          { id: 'l2', cycle_count_id: CC_NEW, counted_quantity: 2, expected_quantity: 2, rechecks: true, count: { count_number: 42, status: 'in_progress', organization_id: ORG } },
          { id: 'l3', cycle_count_id: RECOUNT, counted_quantity: 9, expected_quantity: 2, rechecks: false, count: { count_number: 43, status: 'in_progress', organization_id: ORG } },
        ],
      }),
    );
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ state: 'confirmable', canConfirm: true, otherCount: null });
  });

  it('recount_in_progress: the linked recount is in progress and its line can re-check the item', async () => {
    const row = {
      recount_cycle_count_id: RECOUNT,
      recount: { id: RECOUNT, count_number: 40, status: 'in_progress', completed_at: null },
    };
    const live = svcFor(
      detailResults({
        row,
        lines: [
          { id: 'l1', cycle_count_id: RECOUNT, counted_quantity: null, expected_quantity: 2, rechecks: true, count: { count_number: 40, status: 'in_progress', organization_id: ORG } },
        ],
      }),
    );
    expect((await live.svc.get(OCC)).countConfirm).toMatchObject({ state: 'recount_in_progress', canConfirm: false });
    // A linked recount that no longer holds the item cannot settle it (the
    // database agrees): Confirm is offered.
    const gone = svcFor(detailResults({ row }));
    expect((await gone.svc.get(OCC)).countConfirm).toMatchObject({ state: 'confirmable', canConfirm: true });
  });

  it('stock_moved: the stock on record changed since the count', async () => {
    const { svc } = svcFor(detailResults({ summary: { quantity_on_hand: 5 } }));
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ state: 'stock_moved', onRecordNow: 5, canConfirm: false });
  });

  it('count_changed: a newer count is the item\'s latest; its people are not named as this count\'s', async () => {
    const { svc } = svcFor(detailResults({ summary: { cycle_count_id: CC_NEW, count_number: 40, counted_quantity: 3 } }));
    expect((await svc.get(OCC)).countConfirm).toMatchObject({
      state: 'count_changed',
      canConfirm: false,
      countedBy: null,
      postedBy: null,
      readerIsCounter: false,
    });
  });

  it('not_countable: the item can no longer be counted', async () => {
    const { svc } = svcFor(detailResults({ summary: { item_countable: false, item_is_rental: true } }));
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ state: 'not_countable', canConfirm: false });
  });

  it('already_confirmed: another occurrence of the item confirms this count (from the identity history)', async () => {
    const { svc } = svcFor(
      detailResults({
        history: [
          { id: OCC, occurrence_number: 59, first_seen_at: '2026-09-29T17:01:00Z', resolved_at: null, resolved_reason: null, recurrence_index: 1, confirmed_as: null, confirmed_cycle_count_id: null },
          { id: 'prev', occurrence_number: 58, first_seen_at: '2026-09-29T17:00:00Z', resolved_at: '2026-09-29T17:30:00Z', resolved_reason: 'confirmed', recurrence_index: 0, confirmed_as: 'counter', confirmed_cycle_count_id: CC },
        ],
      }),
    );
    const d = await svc.get(OCC);
    expect(d.countConfirm).toMatchObject({ state: 'already_confirmed', canConfirm: false });
    expect(d.history.map((h) => h.confirmedAs)).toEqual([null, 'counter']);
  });

  it('past the history\'s read limit, already_confirmed is asked directly', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: i === 0 ? OCC : `h-${i}`, occurrence_number: 100 - i, first_seen_at: '2026-09-01T00:00:00Z',
      resolved_at: i === 0 ? null : '2026-09-02T00:00:00Z', resolved_reason: i === 0 ? null : 'cleared',
      recurrence_index: 50 - i, confirmed_as: null, confirmed_cycle_count_id: null,
    }));
    const results = detailResults({ history: many });
    // The history read and the direct read share the table key: the direct
    // one filters on confirmed_cycle_count_id.
    results['exception_occurrences.select'] = (call: MockCall) =>
      call.methods.includes('limit') && call.args[call.methods.indexOf('limit')]![0] === 1
        ? { data: [{ id: 'far-back' }], error: null }
        : { data: many, error: null };
    const { svc, stub } = svcFor(results);
    expect((await svc.get(OCC)).countConfirm).toMatchObject({ state: 'already_confirmed' });
    const direct = stub.chainArgsAll.get('exception_occurrences.select')!.find((args, i) =>
      stub.chainsAll.get('exception_occurrences.select')![i]!.includes('limit') &&
      args.some((a) => a[0] === 'confirmed_cycle_count_id'),
    );
    expect(direct).toBeDefined();
  });

  it('a failed summaries read is contained: reported, state unavailable, the page still renders', async () => {
    const { svc } = svcFor(detailResults({ summaryError: true }));
    const d = await svc.get(OCC);
    expect(d.occurrence.id).toBe(OCC);
    expect(d.countConfirm).toMatchObject({ state: 'unavailable', canConfirm: false, onRecordNow: null });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'exceptions.count_confirm_summary' }));
  });

  it('a failed open-lines read is contained too', async () => {
    const { svc } = svcFor(detailResults({ linesError: true }));
    const d = await svc.get(OCC);
    expect(d.countConfirm).toMatchObject({ state: 'unavailable', canConfirm: false });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'exceptions.count_confirm_open_lines' }));
  });

  it('no block for a resolved row, another rule, or facts that do not name a count and a number', async () => {
    for (const row of [
      { resolved_at: '2026-09-29T19:00:00Z', resolved_reason: 'cleared' },
      { rule: 'over_reserved', facts: { promised: 3, onHand: 1 } },
      { facts: { ...FACTS, cycleCountId: null } },
      { facts: { ...FACTS, counted: null } },
    ]) {
      const { svc } = svcFor(detailResults({ row }));
      expect((await svc.get(OCC)).countConfirm).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The confirmation on rows
// ═══════════════════════════════════════════════════════════════════════════

describe('the confirmation on list and detail rows', () => {
  const CONFIRMED = {
    resolved_at: '2026-09-29T17:41:00Z',
    resolved_reason: 'confirmed',
    confirmed_at: '2026-09-29T17:41:00Z',
    confirmed_by: STAFF,
    confirmed_cycle_count_id: CC,
    confirmed_quantity: '2.0000',
    confirmed_as: 'counter',
    confirmer: { full_name: 'Dana Lee', email: 'dana@x' },
    confirmed_count: { count_number: 35 },
    // Never selected; if a row carried it, it would still not be sent.
    confirmed_on_record: 2,
  };

  it('the detail maps who, when, which count, the number and the role, and no stock on record', async () => {
    const { svc } = svcFor(detailResults({ row: CONFIRMED }));
    const d = await svc.get(OCC);
    expect(d.occurrence.confirmation).toEqual({
      at: '2026-09-29T17:41:00Z',
      by: { id: STAFF, label: 'Dana Lee' },
      cycleCountId: CC,
      countNumber: 35,
      quantity: 2,
      as: 'counter',
    });
    expect(JSON.stringify(d)).not.toContain('onRecord');
    expect(d.countConfirm).toBeNull();
  });

  it('the list maps it the same way; a deleted confirmer reads as a former member', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': {
        data: [cvRow(CONFIRMED), cvRow({ ...CONFIRMED, id: 'other', confirmed_by: null, confirmer: null, confirmed_as: 'manager' })],
        error: null,
      },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const res = await svc.list({ status: 'resolved' });
    expect(res.occurrences.map((o) => [o.confirmation?.by, o.confirmation?.as])).toEqual([
      [{ id: STAFF, label: 'Dana Lee' }, 'counter'],
      [{ id: null, label: 'Former member' }, 'manager'],
    ]);
  });

  it('the select names every foreign key it embeds, and never reads confirmed_on_record', async () => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await svc.list();
    const select = String(stub.chainArgsAll.get('exception_occurrences.select')![0]![0]![0]);
    expect(select).toContain('confirmer:user_profiles!exception_occurrences_confirmed_by_fkey(full_name, email)');
    expect(select).toContain('confirmed_count:cycle_counts!exception_occurrences_confirmed_cycle_count_id_fkey(count_number)');
    expect(select).toContain('item:inventory_items!exception_occurrences_item_id_fkey(name, sku, warehouse_id)');
    expect(select).not.toContain('confirmed_on_record');
    // Every embed of user_profiles or cycle_counts names its foreign key.
    expect(select.match(/(user_profiles|cycle_counts)(?![!])/g) ?? []).toEqual([]);
  });

  it('list({ confirmedOnly }) lists only rows a confirmation closed, and only on the Resolved list', async () => {
    const resolved = svcFor({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await resolved.svc.list({ status: 'resolved', confirmedOnly: true });
    const chain = resolved.stub.chainsAll.get('exception_occurrences.select')![0]!;
    const args = resolved.stub.chainArgsAll.get('exception_occurrences.select')![0]!;
    expect(args[chain.indexOf('not')]).toEqual(['confirmed_at', 'is', null]);

    const open = svcFor({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await open.svc.list({ status: 'open', confirmedOnly: true });
    expect(open.stub.chainsAll.get('exception_occurrences.select')![0]).not.toContain('not');
  });

  it('a count_confirmed event with no actor reads as a former member, never the system', async () => {
    const { svc } = svcFor(
      detailResults({
        row: CONFIRMED,
        extra: {
          'exception_occurrence_events.select': {
            data: [
              { id: 'e1', kind: 'count_confirmed', actor_user_id: null, cycle_count_id: CC, evidence_id: null, maintenance_request_id: null, note: null, created_at: '2026-09-29T17:41:00Z', actor: null, cycle_count: { count_number: 35 } },
            ],
            error: null,
          },
        },
      }),
    );
    expect((await svc.get(OCC)).timeline[0]!.actor).toEqual({ id: null, label: 'Former member' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// confirmCount
// ═══════════════════════════════════════════════════════════════════════════

describe('confirmCount', () => {
  function confirmResults(o: { row?: Record<string, unknown>; rpc?: QueryResult } = {}): Results {
    return {
      'exception_occurrences.select.maybeSingle': { data: cvRow(o.row), error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
      'rpc:exception_confirm_count': o.rpc ?? {
        data: { occurrenceId: OCC, replay: false, confirmedAs: 'counter' },
        error: null,
      },
    };
  }

  it('calls the RPC with the count, the number and the trimmed note, audits once, and returns the re-read row', async () => {
    const { svc, stub } = svcFor(confirmResults());
    const res = await svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2, note: '  counted twice  ' });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'exception_confirm_count',
        args: { p_id: OCC, p_cycle_count_id: CC, p_counted_quantity: 2, p_note: 'counted twice' },
      },
    ]);
    expect(res.replay).toBe(false);
    expect(res.occurrence.id).toBe(OCC);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      {
        event: 'exception.count_confirmed',
        entityType: 'exception_occurrence',
        entityId: OCC,
        after: { cycleCountId: CC, countedQuantity: 2, confirmedAs: 'counter', note: 'counted twice' },
      },
      expect.objectContaining({ organizationId: ORG }),
    );
  });

  it('a replay writes no second audit row', async () => {
    const { svc } = svcFor(confirmResults({ rpc: { data: { occurrenceId: OCC, replay: true, confirmedAs: 'counter' }, error: null } }));
    const res = await svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 });
    expect(res.replay).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('refuses a bad count id, a number that is not finite and an over-long note before any read', async () => {
    const { svc, stub } = svcFor(confirmResults());
    await expect(svc.confirmCount(OCC, { cycleCountId: 'nope', countedQuantity: 2 })).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'invalid_argument' },
    });
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: n })).rejects.toMatchObject({
        details: { reason: 'invalid_argument' },
      });
    }
    await expect(svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2, note: 'x'.repeat(1001) })).rejects.toMatchObject({
      details: { reason: 'note_too_long' },
    });
    await expect(svc.confirmCount('not-a-uuid', { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('the app gate runs before the RPC: a viewer, a row the caller cannot see, and staff without write access to the ITEM\'s warehouse are refused without it', async () => {
    const viewer = svcFor(confirmResults(), { role: 'viewer' });
    await expect(viewer.svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(viewer.stub.rpcCalls).toEqual([]);

    const hidden = svcFor({ ...confirmResults(), 'exception_occurrences.select.maybeSingle': { data: null, error: null } });
    await expect(hidden.svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({ code: 'not_found' });
    expect(hidden.stub.rpcCalls).toEqual([]);

    const moved = svcFor(confirmResults({ row: { item: { name: 'U', sku: 'U1', warehouse_id: 'wh-b' } } }));
    await expect(moved.svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(moved.stub.rpcCalls).toEqual([]);
  });

  it('the live warehouse lets through a counter whose item moved INTO their warehouse (the stamp still says another)', async () => {
    const { svc, stub } = svcFor(confirmResults({ row: { warehouse_id: 'wh-b' } }));
    await svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['exception_confirm_count']);
  });

  it('maps the RPC answers by SQLSTATE and hint, and a refusal writes no audit row', async () => {
    const { svc } = svcFor(
      confirmResults({ rpc: { data: null, error: { message: 'stock_moved', code: 'P0001', hint: 'stock_moved' } } }),
    );
    await expect(svc.confirmCount(OCC, { cycleCountId: CC, countedQuantity: 2 })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'stock_moved' },
    });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('mapConfirmError', () => {
  const cases: Array<[{ code: string; hint?: string | null; message?: string }, string, Record<string, unknown> | undefined]> = [
    [{ code: '42501', hint: 'not_counter' }, 'forbidden', { reason: 'not_counter' }],
    [{ code: '42501', hint: 'not_permitted' }, 'forbidden', { reason: 'not_permitted' }],
    [{ code: '42501', hint: 'not_authenticated' }, 'unauthenticated', undefined],
    // EXECUTE revoked (the revert kit): PostgREST answers 42501 with no hint.
    [{ code: '42501' }, 'conflict', { reason: 'unavailable' }],
    [{ code: '42501', hint: null }, 'conflict', { reason: 'unavailable' }],
    // A hint added by a proxy or an extension is not one of ours: unavailable.
    [{ code: '42501', hint: 'Grant the required privileges to the current role' }, 'conflict', { reason: 'unavailable' }],
    [{ code: 'P0002' }, 'not_found', undefined],
    [{ code: 'P0001', hint: 'occurrence_resolved' }, 'conflict', { reason: 'occurrence_resolved' }],
    [{ code: 'P0001', hint: 'count_changed' }, 'conflict', { reason: 'count_changed' }],
    [{ code: 'P0001', hint: 'recount_in_progress' }, 'conflict', { reason: 'recount_in_progress' }],
    [{ code: 'P0001', hint: 'count_in_progress' }, 'conflict', { reason: 'count_in_progress' }],
    [{ code: 'P0001', hint: 'not_countable' }, 'conflict', { reason: 'not_countable' }],
    [{ code: 'P0001', hint: 'stock_moved' }, 'conflict', { reason: 'stock_moved' }],
    [{ code: 'P0001', hint: 'already_confirmed' }, 'conflict', { reason: 'already_confirmed' }],
    [{ code: 'P0001', hint: 'not_confirmable' }, 'conflict', { reason: 'not_confirmable' }],
    [{ code: 'P0001', hint: 'a_later_reason' }, 'conflict', { reason: 'unknown' }],
    [{ code: 'P0001' }, 'conflict', { reason: 'unknown' }],
    [{ code: '22023', hint: 'note_too_long' }, 'validation_error', { reason: 'note_too_long' }],
    [{ code: '22023', hint: 'invalid_argument' }, 'validation_error', { reason: 'invalid_argument' }],
    [{ code: '23505' }, 'conflict', { reason: 'already_confirmed' }],
    [{ code: '55P03' }, 'conflict', { reason: 'busy', retryable: true }],
    [{ code: '57014' }, 'internal_error', undefined],
    [{ code: '40001' }, 'internal_error', undefined],
  ];

  it.each(cases)('%j answers %s %j', (error, code, details) => {
    const e = mapConfirmError({ message: 'x', ...error });
    expect(e.code).toBe(code);
    if (details) expect(e.details).toEqual(details);
    else if (code !== 'internal_error') expect(e.details ?? undefined).toBeUndefined();
    // Every answer a person can meet is a sentence, never a code.
    if (code !== 'internal_error') expect(e.message).toMatch(/^[A-Z].*\.$/);
  });

  it('never keys on the message text', () => {
    expect(mapConfirmError({ code: 'P0001', hint: 'stock_moved', message: 'occurrence_resolved' }).details).toEqual({
      reason: 'stock_moved',
    });
  });
});
