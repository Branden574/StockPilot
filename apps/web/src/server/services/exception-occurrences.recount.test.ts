import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * The recount state and outcome the Exception Center's list, detail and a
 * count's "Linked exceptions" carry (F1-2). Everything is read through the
 * caller's own client; a failed outcome read is "Result not available",
 * never "matched" and never a failed list.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: ['wh-a'], writableIds: ['wh-a'] })),
    assertWarehouseAccess: vi.fn(async () => undefined),
  };
});

import { ExceptionOccurrencesService } from './exception-occurrences';

const ORG = 'org-1';
const OCC = '11111111-1111-4111-8111-111111111111';
const OCC2 = '22222222-2222-4222-8222-222222222222';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CC_OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const SYNC_ROW = {
  tracking_started_at: '2026-09-24T15:00:00Z',
  last_evaluated_at: '2026-09-24T18:00:00Z',
  last_synced_at: '2026-09-24T18:00:02Z',
  complete_rules: ['count_variance'],
  failed_rules: [],
  truncated_rules: [],
};

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    organization_id: ORG,
    occurrence_number: 42,
    rule: 'count_variance',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: { itemName: 'Atlas', expected: 10, counted: 11, variance: 1, countNumber: 24 },
    condition_since: '2026-09-20T10:00:00Z',
    first_seen_at: '2026-09-24T15:00:00Z',
    last_seen_at: '2026-09-24T18:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    item: { name: 'Atlas', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

const recountEmbed = (status: string, id = CC) => ({
  recount_cycle_count_id: id,
  recount: { id, count_number: 31, status, completed_at: status === 'completed' ? '2026-09-25T09:00:00Z' : null },
});

/** Head-count answers for a count's lines: all of them, or the counted ones. */
function progress(total: number, counted: number) {
  return (call: MockCall) => ({
    data: null,
    error: null,
    count: call.methods.includes('not') ? counted : total,
  });
}

function svcFor(
  results: Parameters<typeof makeSupabaseStub>[0],
  opts: {
    role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
    enabledModules?: Set<ModuleId>;
  } = {},
) {
  const stub = makeSupabaseStub({
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    ...results,
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG,
    role: opts.role ?? 'manager',
    ...(opts.enabledModules ? { enabledModules: opts.enabledModules } : {}),
  });
  return { svc: new ExceptionOccurrencesService(ctx as never), stub };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canRecount', () => {
  it('a manager may recount open count_variance and over_reserved rows, and nothing else', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': {
        data: [
          occRow(),
          occRow({ id: 'o2', rule: 'over_reserved', facts: { promised: 3, onHand: 1 } }),
          occRow({ id: 'o3', rule: 'label_mismatch', facts: {} }),
        ],
        error: null,
      },
    });
    const res = await svc.list();
    expect(res.canRecount).toBe(true);
    expect(Object.fromEntries(res.occurrences.map((o) => [o.id, o.canRecount]))).toEqual({
      [OCC]: true,
      o2: true,
      o3: false,
    });
  });

  // Mutation caught: offering Recount on stock:adjust alone — staff hold it,
  // and the recount (like any count start) is manager-only.
  it('staff are never offered Recount, and neither is anyone when the module is off', async () => {
    const staff = svcFor({ 'exception_occurrences.select': { data: [occRow()], error: null } }, { role: 'staff' });
    const s = await staff.svc.list();
    expect(s.canRecount).toBe(false);
    expect(s.occurrences[0]!.canRecount).toBe(false);

    const off = svcFor(
      { 'exception_occurrences.select': { data: [occRow()], error: null } },
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'cycle_counts')) },
    );
    expect((await off.svc.list()).occurrences[0]!.canRecount).toBe(false);
  });

  it('a resolved row cannot be recounted', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': {
        data: [occRow({ resolved_at: '2026-09-25T10:00:00Z', resolved_reason: 'cleared' })],
        error: null,
      },
    });
    expect((await svc.list({ status: 'resolved' })).occurrences[0]!.canRecount).toBe(false);
  });
});

describe('list({ itemId }) — one item\'s occurrences ("Count this item" links them)', () => {
  it('narrows the read to the item, org-scoped as ever', async () => {
    const { svc, stub } = svcFor({ 'exception_occurrences.select': { data: [occRow()], error: null } });
    await svc.list({ itemId: '33333333-3333-4333-8333-333333333333' });
    const chain = stub.chainsAll.get('exception_occurrences.select')![0]!;
    const args = stub.chainArgsAll.get('exception_occurrences.select')![0]!;
    const eqs = chain.flatMap((m, i) => (m === 'eq' ? [args[i]] : []));
    expect(eqs).toEqual([
      ['organization_id', ORG],
      ['item_id', '33333333-3333-4333-8333-333333333333'],
    ]);
  });

  it('a malformed item id is refused without a query', async () => {
    const { svc, stub } = svcFor({});
    await expect(svc.list({ itemId: 'nope' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'invalid_item_id' },
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('the recount outcome on the list', () => {
  it('a recount in progress says how many of its lines are counted', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': { data: [occRow(recountEmbed('in_progress'))], error: null },
      'cycle_counts.select': servedLikePostgrest([{ id: CC, organization_id: ORG, status: 'in_progress' }]),
      'cycle_count_lines.select': progress(5, 2),
    });
    const [o] = (await svc.list()).occurrences;
    expect(o!.recount).toMatchObject({
      cycleCountId: CC,
      countNumber: 31,
      status: 'in_progress',
      outcome: { kind: 'in_progress', counted: 2, total: 5 },
    });
  });

  it('a posted recount says what it found for THIS item (the Re-checking window)', async () => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select': { data: [occRow(recountEmbed('completed'))], error: null },
      'cycle_counts.select': servedLikePostgrest([{ id: CC, organization_id: ORG, status: 'completed' }]),
      'cycle_count_lines.select': servedLikePostgrest([
        { id: 'l1', cycle_count_id: CC, item_id: 'item-1', counted_quantity: 11, expected_quantity: 11 },
        { id: 'l2', cycle_count_id: CC, item_id: 'item-9', counted_quantity: 1, expected_quantity: 5 },
      ]),
    });
    const [o] = (await svc.list()).occurrences;
    expect(o!.recount!.outcome).toEqual({ kind: 'matched', quantity: 11 });
    // Read for this count's lines of this item only.
    const chain = stub.chainsAll.get('cycle_count_lines.select')![0]!;
    const args = stub.chainArgsAll.get('cycle_count_lines.select')![0]!;
    expect(args[chain.indexOf('eq')]).toEqual(['cycle_count_id', CC]);
    expect(args[chain.indexOf('in')]).toEqual(['item_id', ['item-1']]);
  });

  // Mutation caught: failing the whole list on an outcome read, or reading a
  // failure as a result.
  it('a failed outcome read is "not available", reported, and the list still loads', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': { data: [occRow(recountEmbed('completed'))], error: null },
      'cycle_counts.select': { data: null, error: { message: 'stall' } },
    });
    const res = await svc.list();
    expect(res.occurrences[0]!.recount!.outcome).toEqual({ kind: 'unavailable' });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.recount_outcome']);
  });

  it('no recount pointer, no outcome reads at all', async () => {
    const { svc, stub } = svcFor({ 'exception_occurrences.select': { data: [occRow()], error: null } });
    await svc.list();
    expect(stub.fromCalls).not.toContain('cycle_counts');
    expect(stub.fromCalls).not.toContain('cycle_count_lines');
  });
});

describe('the detail timeline names what each closed recount came to', () => {
  it('recount_closed carries the outcome; recount_linked does not', async () => {
    const event = (id: string, kind: string, cc: string | null, n: number | null) => ({
      id,
      kind,
      actor_user_id: kind === 'recount_linked' ? 'u-1' : null,
      cycle_count_id: cc,
      evidence_id: null,
      maintenance_request_id: null,
      note: null,
      created_at: `2026-09-2${id.slice(1)}T10:00:00Z`,
      actor: kind === 'recount_linked' ? { full_name: 'Mo Manager', email: 'm@x' } : null,
      cycle_count: n === null ? null : { count_number: n },
    });
    const { svc } = svcFor({
      'exception_occurrences.select.maybeSingle': { data: occRow(recountEmbed('in_progress')), error: null },
      'exception_occurrence_events.select': {
        data: [
          event('e1', 'raised', null, null),
          event('e2', 'recount_linked', CC_OLD, 30),
          event('e3', 'recount_closed', CC_OLD, 30),
          event('e4', 'recount_linked', CC, 31),
        ],
        error: null,
      },
      'exception_occurrences.select': { data: [], error: null },
      'cycle_counts.select': servedLikePostgrest([
        { id: CC_OLD, organization_id: ORG, status: 'completed' },
        { id: CC, organization_id: ORG, status: 'in_progress' },
      ]),
      'cycle_count_lines.select': (call: MockCall) =>
        call.methods.includes('in')
          ? servedLikePostgrest([
              { id: 'l1', cycle_count_id: CC_OLD, item_id: 'item-1', counted_quantity: 11, expected_quantity: 10 },
            ])(call)
          : progress(3, 1)(call),
    });
    const d = await svc.get(OCC);
    const closed = d.timeline.find((e) => e.kind === 'recount_closed')!;
    expect(closed.cycleCount).toEqual({
      id: CC_OLD,
      countNumber: 30,
      outcome: { kind: 'corrected', from: 10, to: 11, delta: 1 },
    });
    expect(d.timeline.find((e) => e.id === 'e4')!.cycleCount).toEqual({ id: CC, countNumber: 31 });
    expect(d.occurrence.recount!.outcome).toEqual({ kind: 'in_progress', counted: 1, total: 3 });
  });
});

describe('listForCount — a count\'s linked exceptions', () => {
  function countStub(opts: { header?: unknown; links?: unknown; lines?: unknown[]; occurrences?: unknown[] } = {}) {
    return svcFor({
      'cycle_counts.select.maybeSingle': {
        data: opts.header === undefined ? { id: CC, count_number: 31, status: 'completed' } : opts.header,
        error: null,
      },
      'exception_occurrence_events.select':
        (opts.links as never) ?? {
          data: [
            { id: 'e1', occurrence_id: OCC },
            { id: 'e2', occurrence_id: OCC2 },
            { id: 'e3', occurrence_id: OCC },
          ],
          error: null,
        },
      'exception_occurrences.select': servedLikePostgrest(
        (opts.occurrences as Array<Record<string, unknown>>) ?? [
          occRow({ id: OCC2, occurrence_number: 43, item_id: 'item-2' }),
          occRow(recountEmbed('completed')),
        ],
      ),
      'cycle_count_lines.select': servedLikePostgrest(
        (opts.lines as Array<Record<string, unknown>>) ?? [
          {
            id: 'l1',
            cycle_count_id: CC,
            item_id: 'item-1',
            counted_quantity: 11,
            expected_quantity: 10,
            counted_location_id: 'loc-12a',
            counted_location: { name: 'Rack 12-A', kind: 'rack', deleted_at: null },
          },
          {
            id: 'l2',
            cycle_count_id: CC,
            item_id: 'item-2',
            counted_quantity: 4,
            expected_quantity: 6,
            counted_location: null,
          },
        ],
      ),
    });
  }

  it('lists each linked exception once, in EX order, with its line, outcome and where the difference lands', async () => {
    const { svc } = countStub();
    const res = await svc.listForCount(CC);
    expect(res).toMatchObject({ cycleCountId: CC, countNumber: 31, reference: 'CC-000031', status: 'completed' });
    expect(res.exceptions.map((e) => e.occurrence.id)).toEqual([OCC, OCC2]);
    const [a, b] = res.exceptions;
    expect(a).toMatchObject({
      active: true,
      line: {
        id: 'l1',
        countedQuantity: 11,
        expectedQuantity: 10,
        countedLocationId: 'loc-12a',
        countedLocation: { name: 'Rack 12-A', kind: 'rack', archived: false },
      },
      outcome: { kind: 'corrected', from: 10, to: 11, delta: 1 },
      destination: { kind: 'adds_to_location', location: 'Rack 12-A' },
      reviewLine: 'Counted 11, book 10 (+1): adds to Rack 12-A',
    });
    expect(a!.occurrence.recount!.outcome).toEqual({ kind: 'corrected', from: 10, to: 11, delta: 1 });
    expect(b).toMatchObject({
      active: false,
      // A line with no counted location says so (null), never a made-up id.
      line: { countedLocationId: null, countedLocation: null },
      destination: { kind: 'off_staging_then_shelves' },
      reviewLine: 'Counted 4, book 6 (-2): comes off Staging first, then shelf locations',
    });
  });

  it('reads the links for THIS count and org only', async () => {
    const { svc, stub } = countStub();
    await svc.listForCount(CC);
    const chain = stub.chainsAll.get('exception_occurrence_events.select')![0]!;
    const args = stub.chainArgsAll.get('exception_occurrence_events.select')![0]!;
    const eqs = chain.flatMap((m, i) => (m === 'eq' ? [args[i]] : []));
    expect(eqs).toEqual([
      ['organization_id', ORG],
      ['cycle_count_id', CC],
      ['kind', 'recount_linked'],
    ]);
  });

  it('a count that does not exist (or is not visible) is not_found; a bad id never queries', async () => {
    const { svc } = countStub({ header: null });
    await expect(svc.listForCount(CC)).rejects.toMatchObject({ code: 'not_found' });
    const bad = countStub();
    await expect(bad.svc.listForCount('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(bad.stub.fromCalls).toEqual([]);
  });

  // Mutation caught: a failed read answered as "no linked exceptions".
  it('a failed read throws — it is never an empty list', async () => {
    const { svc } = countStub({ links: { data: null, error: { message: 'stall' } } });
    await expect(svc.listForCount(CC)).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('an uncounted line has no destination and reads "posted without counting"', async () => {
    const { svc } = countStub({
      occurrences: [occRow()],
      links: { data: [{ id: 'e1', occurrence_id: OCC }], error: null },
      lines: [
        {
          id: 'l1',
          cycle_count_id: CC,
          item_id: 'item-1',
          counted_quantity: null,
          expected_quantity: 10,
          counted_location: null,
        },
      ],
    });
    const [e] = (await svc.listForCount(CC)).exceptions;
    expect(e).toMatchObject({ outcome: { kind: 'not_counted' }, destination: null, reviewLine: null });
  });
});
