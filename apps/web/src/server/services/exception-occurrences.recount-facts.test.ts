import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * The Exception Center reads what each recount came to through one function,
 * exception_recount_facts (migration 0460), with the caller's own client: for
 * the exceptions the caller may see, the counts each names, the line of the
 * exception's item in its open and closed recounts, and an open recount's
 * progress. So a member who may read an exception but not cycle counts (a
 * viewer) sees the same recount state and words as a counter.
 *
 * Until the database has the function (the web is live before the migration
 * is pushed), PostgREST answers PGRST202 (Postgres 42883) naming it, and the
 * service reads the counts directly, exactly as before. Any other failure is
 * a failed read: never "no recount".
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

/** A row as a viewer reads it under 0460: the recount pointer is there, the
 *  count embeds are not (she may not read cycle counts). */
const viewerRecountRow = (o: Record<string, unknown> = {}) =>
  occRow({ recount_cycle_count_id: CC, recount: null, ...o });

type Fact = {
  exception_id: string;
  cycle_count_id: string;
  is_active_recount: boolean;
  is_closed_recount: boolean;
  count_number: number | null;
  status: string;
  completed_at: string | null;
  line_total: number | null;
  line_counted: number | null;
  line_found: boolean | null;
  counted_quantity: number | string | null;
  expected_quantity: number | string | null;
  rechecks: boolean | null;
};

function fact(o: Partial<Fact> = {}): Fact {
  return {
    exception_id: OCC,
    cycle_count_id: CC,
    is_active_recount: true,
    is_closed_recount: false,
    count_number: 31,
    status: 'in_progress',
    completed_at: null,
    line_total: 5,
    line_counted: 2,
    line_found: true,
    counted_quantity: null,
    expected_quantity: '10.0000',
    rechecks: true,
    ...o,
  };
}

const factsAnswer = (rows: Fact[]) => ({ data: rows, error: null });
const MISSING_PGRST202 = {
  data: null,
  error: {
    code: 'PGRST202',
    message: 'Could not find the function public.exception_recount_facts(p_exception_ids, p_org) in the schema cache',
  },
};
const MISSING_42883 = {
  data: null,
  error: { code: '42883', message: 'function public.exception_recount_facts(uuid, uuid[]) does not exist' },
};

/** Head-count answers for a count's lines: all of them, or the counted ones. */
function progress(total: number, counted: number) {
  return (call: MockCall) => ({
    data: null,
    error: null,
    count: call.methods.includes('not') ? counted : total,
  });
}

function svcFor(results: Parameters<typeof makeSupabaseStub>[0], role: 'manager' | 'staff' | 'viewer' = 'viewer') {
  const stub = makeSupabaseStub({
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    ...results,
  });
  const ctx = makeServiceContext(stub.client, { organizationId: ORG, role });
  return { svc: new ExceptionOccurrencesService(ctx as never), stub };
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('with exception_recount_facts in the database', () => {
  it('the list takes the open recount and its progress from the function, and reads no count directly', async () => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select': { data: [viewerRecountRow(), occRow({ id: OCC2 })], error: null },
      'rpc:exception_recount_facts': factsAnswer([fact()]),
    });
    const res = await svc.list();
    expect(res.occurrences[0]!.recount).toMatchObject({
      cycleCountId: CC,
      countNumber: 31,
      status: 'in_progress',
      outcome: { kind: 'in_progress', counted: 2, total: 5 },
    });
    expect(res.occurrences[1]!.recount).toBeNull();
    // Asked once, in the active organization, for the rows that name a count.
    expect(stub.rpcCalls).toEqual([
      { name: 'exception_recount_facts', args: { p_org: ORG, p_exception_ids: [OCC] } },
    ]);
    expect(stub.fromCalls).not.toContain('cycle_counts');
    expect(stub.fromCalls).not.toContain('cycle_count_lines');
  });

  it('a posted recount reads what it found for the exception\'s item', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': { data: [viewerRecountRow()], error: null },
      'rpc:exception_recount_facts': factsAnswer([
        fact({
          status: 'completed',
          completed_at: '2026-09-25T09:00:00Z',
          line_total: null,
          line_counted: null,
          counted_quantity: '7.0000',
          expected_quantity: '5.0000',
        }),
      ]),
    });
    const [o] = (await svc.list()).occurrences;
    expect(o!.recount).toMatchObject({ status: 'completed', completedAt: '2026-09-25T09:00:00Z' });
    expect(o!.recount!.outcome).toEqual({ kind: 'corrected', from: 5, to: 7, delta: 2 });
  });

  it('a posted recount with no line of the item, or a line that cannot re-check it, never reads "matched"', async () => {
    const posted = { status: 'completed', line_total: null, line_counted: null };
    const noLine = svcFor({
      'exception_occurrences.select': { data: [viewerRecountRow()], error: null },
      'rpc:exception_recount_facts': factsAnswer([
        fact({ ...posted, line_found: false, counted_quantity: null, expected_quantity: null, rechecks: null }),
      ]),
    });
    expect((await noLine.svc.list()).occurrences[0]!.recount!.outcome).toEqual({ kind: 'unavailable' });
    const superseded = svcFor({
      'exception_occurrences.select': { data: [viewerRecountRow()], error: null },
      'rpc:exception_recount_facts': factsAnswer([
        fact({ ...posted, counted_quantity: 10, expected_quantity: 10, rechecks: false }),
      ]),
    });
    expect((await superseded.svc.list()).occurrences[0]!.recount!.outcome).toEqual({ kind: 'superseded' });
  });

  it('a confirmed exception names the count that confirmed it', async () => {
    const { svc } = svcFor({
      'exception_occurrences.select': {
        data: [
          occRow({
            resolved_at: '2026-09-25T10:00:00Z',
            resolved_reason: 'confirmed',
            confirmed_at: '2026-09-25T10:00:00Z',
            confirmed_by: 'u-2',
            confirmer: { full_name: 'Cy Counter', email: 'c@x' },
            confirmed_cycle_count_id: CC_OLD,
            confirmed_quantity: 11,
            confirmed_as: 'counter',
            confirmed_count: null,
          }),
        ],
        error: null,
      },
      'rpc:exception_recount_facts': factsAnswer([
        fact({
          cycle_count_id: CC_OLD,
          is_active_recount: false,
          count_number: 24,
          status: 'completed',
          line_found: null,
          line_total: null,
          line_counted: null,
          counted_quantity: null,
          expected_quantity: null,
          rechecks: null,
        }),
      ]),
    });
    const [o] = (await svc.list({ status: 'resolved' })).occurrences;
    expect(o!.confirmation).toMatchObject({ cycleCountId: CC_OLD, countNumber: 24 });
    expect(o!.recount).toBeNull();
  });

  it('the detail names every recount on its timeline from the function, and reads no count directly', async () => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select.maybeSingle': { data: viewerRecountRow(), error: null },
      'exception_occurrence_events.select': {
        data: [
          event('e1', 'raised', null, null),
          // The embeds a viewer reads under 0460: none.
          event('e2', 'recount_linked', CC_OLD, null),
          event('e3', 'recount_closed', CC_OLD, null),
          event('e4', 'recount_linked', CC, null),
        ],
        error: null,
      },
      'exception_occurrences.select': { data: [], error: null },
      'rpc:exception_recount_facts': factsAnswer([
        fact({ line_total: 3, line_counted: 1 }),
        fact({
          cycle_count_id: CC_OLD,
          is_active_recount: false,
          is_closed_recount: true,
          count_number: 30,
          status: 'completed',
          line_total: null,
          line_counted: null,
          counted_quantity: 11,
          expected_quantity: 10,
        }),
      ]),
    });
    const d = await svc.get(OCC);
    expect(d.timeline.find((e) => e.kind === 'recount_closed')!.cycleCount).toEqual({
      id: CC_OLD,
      countNumber: 30,
      outcome: { kind: 'corrected', from: 10, to: 11, delta: 1 },
    });
    expect(d.timeline.find((e) => e.id === 'e2')!.cycleCount).toEqual({ id: CC_OLD, countNumber: 30 });
    expect(d.timeline.find((e) => e.id === 'e4')!.cycleCount).toEqual({ id: CC, countNumber: 31 });
    expect(d.occurrence.recount).toMatchObject({
      cycleCountId: CC,
      countNumber: 31,
      outcome: { kind: 'in_progress', counted: 1, total: 3 },
    });
    expect(stub.rpcCalls.filter((c) => c.name === 'exception_recount_facts')).toEqual([
      { name: 'exception_recount_facts', args: { p_org: ORG, p_exception_ids: [OCC] } },
    ]);
    // No recount read of a count: no header read, and no line read of one
    // count (the Confirm block's own read of the item's lines in open counts
    // is a separate read, by item, and stays).
    expect(stub.fromCalls).not.toContain('cycle_counts');
    const lineReads = stub.chainArgsAll.get('cycle_count_lines.select') ?? [];
    expect(lineReads.some((args) => args.some((a) => a[0] === 'cycle_count_id'))).toBe(false);
  });

  it('a list with more than 500 rows naming counts asks in batches of 500', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const { svc, stub } = svcFor({
      'exception_occurrences.select': servedLikePostgrest(
        ids.map((id, i) => viewerRecountRow({ id, occurrence_number: i + 1 })),
      ),
      'rpc:exception_recount_facts': factsAnswer([]),
    });
    await svc.list();
    const asked = stub.rpcCalls.map((c) => (c.args as { p_exception_ids: string[] }).p_exception_ids.length);
    expect(asked).toEqual([500, 1]);
  });
});

describe('before the database has exception_recount_facts', () => {
  const directReads = {
    'cycle_counts.select': servedLikePostgrest([{ id: CC, organization_id: ORG, status: 'in_progress' }]),
    'cycle_count_lines.select': progress(5, 2),
  };

  it.each([
    ['PGRST202', MISSING_PGRST202],
    ['42883', MISSING_42883],
  ])('%s naming the function: the counts are read directly, and the list shows what it showed before', async (_code, missing) => {
    const holderRow = occRow({
      recount_cycle_count_id: CC,
      recount: { id: CC, count_number: 31, status: 'in_progress', completed_at: null },
    });
    // The same read with the function present and in agreement.
    const withFn = svcFor(
      {
        'exception_occurrences.select': { data: [holderRow], error: null },
        'rpc:exception_recount_facts': factsAnswer([fact()]),
      },
      'manager',
    );
    const fallback = svcFor(
      {
        'exception_occurrences.select': { data: [holderRow], error: null },
        'rpc:exception_recount_facts': missing,
        ...directReads,
      },
      'manager',
    );
    const [f] = (await fallback.svc.list()).occurrences;
    const [w] = (await withFn.svc.list()).occurrences;
    // The words the list has always shown for this recount (the direct
    // reads: exception-occurrences.recount.test.ts pins them further), and
    // the same answer as the function's.
    expect(f!.recount).toEqual({
      cycleCountId: CC,
      countNumber: 31,
      status: 'in_progress',
      completedAt: null,
      outcome: { kind: 'in_progress', counted: 2, total: 5 },
    });
    expect(w).toEqual(f);
    expect(fallback.stub.fromCalls).toContain('cycle_counts');
    expect(fallback.stub.fromCalls).toContain('cycle_count_lines');
  });

  it('the detail falls back too', async () => {
    const { svc, stub } = svcFor(
      {
        'exception_occurrences.select.maybeSingle': {
          data: occRow({
            recount_cycle_count_id: CC,
            recount: { id: CC, count_number: 31, status: 'in_progress', completed_at: null },
          }),
          error: null,
        },
        'exception_occurrence_events.select': { data: [event('e4', 'recount_linked', CC, 31)], error: null },
        'exception_occurrences.select': { data: [], error: null },
        'rpc:exception_recount_facts': MISSING_PGRST202,
        ...directReads,
      },
      'manager',
    );
    const d = await svc.get(OCC);
    expect(d.occurrence.recount!.outcome).toEqual({ kind: 'in_progress', counted: 2, total: 5 });
    expect(stub.fromCalls).toContain('cycle_count_lines');
  });
});

describe('when exception_recount_facts fails', () => {
  const failures: Array<[string, unknown]> = [
    ['a statement timeout', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }],
    ['42883 about another function', { data: null, error: { code: '42883', message: 'function public.other_fn(uuid) does not exist' } }],
    ['PGRST202 about another function', { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.other_fn in the schema cache' } }],
    ['an answer that is not a list', { data: null, error: null }],
  ];

  it.each(failures)('%s fails the list (the page then says the list is unavailable), never "no recount"', async (_what, answer) => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select': { data: [viewerRecountRow()], error: null },
      'rpc:exception_recount_facts': answer as never,
    });
    await expect(svc.list()).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.fromCalls).not.toContain('cycle_counts');
  });

  it.each(failures)('%s fails the detail', async (_what, answer) => {
    const { svc } = svcFor({
      'exception_occurrences.select.maybeSingle': { data: viewerRecountRow(), error: null },
      'exception_occurrence_events.select': { data: [], error: null },
      'exception_occurrences.select': { data: [], error: null },
      'rpc:exception_recount_facts': answer as never,
    });
    await expect(svc.get(OCC)).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('a list with no row naming a count does not ask', async () => {
    const { svc, stub } = svcFor({
      'exception_occurrences.select': { data: [occRow()], error: null },
      'rpc:exception_recount_facts': { data: null, error: { code: '57014', message: 'timeout' } },
    });
    await svc.list();
    expect(stub.rpcCalls).toEqual([]);
  });
});
