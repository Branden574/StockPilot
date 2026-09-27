import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODULE_IDS,
  parseItemVerificationSummary,
  verificationSummaryCopy,
  type ModuleId,
} from '@stockpilot/core';

import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * GET /api/v1/items/[id]/verification (F1-3) runs the REAL VerificationService
 * over a stubbed client, so the statuses below are the service's own answers:
 * 401 without a session, 403 without items:read (or at the MFA step-up), 404
 * for an item the reader cannot see, 400 for a bad id, and a 500 that says
 * "Couldn't load verification" for any read that did not complete, never an
 * empty summary the phone would word as "No physical count on record."
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

const ITEM = '11111111-1111-4111-8111-111111111111';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SUMMARY_ROW = {
  item_id: ITEM,
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
  counted_by: 'u-post',
  counted_at: '2026-09-12T15:02:00Z',
  captured_at: null,
  baseline_at: '2026-09-12T15:02:00Z',
  expected_quantity: 8,
  expected_at_start: 8,
  counted_quantity: 10,
  counted_location_id: null,
  counted_location_name: null,
  counted_location_kind: null,
  counted_location_archived: null,
  ai_assisted: false,
  movements_since: 1,
  outside_ledger_since: 0,
  open_count_id: null,
  open_count_number: null,
};

function summaries(rows: Record<string, unknown>[]) {
  return (call: MockCall): QueryResult => {
    const ids = (call.args[0]?.[0] as { p_item_ids: string[] }).p_item_ids;
    return { data: rows.filter((r) => ids.includes(r.item_id as string)), error: null };
  };
}

function ctxWith(
  results: Parameters<typeof makeSupabaseStub>[0],
  opts: {
    role?: 'owner' | 'manager' | 'staff' | 'viewer';
    permissions?: string[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
    mfaEnrolled?: boolean;
  } = {},
) {
  const stub = makeSupabaseStub({
    'exception_occurrences.select': { data: [], error: null },
    'exception_sync_state.select.maybeSingle': {
      data: { last_synced_at: '2026-09-24T18:00:02Z' },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
    'user_profiles.select': {
      data: [{ id: 'u-post', full_name: 'Blake', email: null }],
      error: null,
    },
    ...results,
  });
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: opts.role ?? 'manager',
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    supabase: stub.client as never,
    mfaRequired: opts.mfaRequired ?? false,
    mfaSatisfied: opts.mfaSatisfied ?? true,
    mfaEnrolled: opts.mfaEnrolled ?? false,
    enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
  };
  vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
  return stub;
}

const bearer = (url: string) =>
  new Request(url, { headers: { authorization: 'Bearer token-1' } }) as never;
const cookie = (url: string) =>
  new Request(url, { headers: { cookie: 'sb-x-auth-token=abc' } }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const URL_ = `https://t.local/api/v1/items/${ITEM}/verification`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/items/[id]/verification', () => {
  it('401 without a session, and reads nothing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(bearer(URL_), params(ITEM));
    expect(res.status).toBe(401);
  });

  it('serves a Bearer caller and a cookie caller alike, handing the request to withApiContext', async () => {
    for (const make of [bearer, cookie]) {
      const stub = ctxWith({ 'rpc:item_verification_summaries': summaries([SUMMARY_ROW]) });
      const request = make(URL_);
      const res = await GET(request, params(ITEM));
      expect(res.status).toBe(200);
      expect(vi.mocked(withApiContext).mock.lastCall?.[0]).toBe(request);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = await res.json();
      expect(body).toMatchObject({
        organizationId: 'org-1',
        itemId: ITEM,
        checkedAt: '2026-09-24T18:00:02Z',
        timeZone: 'America/Chicago',
        canCount: true,
        countUnavailableReason: null,
        openIssues: [],
        openIssuesTruncated: false,
      });
      // The RPC is asked for this org and this item, as the reader.
      expect(stub.rpcCalls).toEqual([
        { name: 'item_verification_summaries', args: { p_org: 'org-1', p_item_ids: [ITEM] } },
      ]);
      // What the phone does with it: parse, then word it with core.
      const parsed = parseItemVerificationSummary(body.summary);
      expect(parsed).not.toBeNull();
      const copy = verificationSummaryCopy(parsed, {
        timeZone: body.timeZone,
        canCount: body.canCount,
      });
      expect(copy.lines).toEqual([
        'Last physical count: Sep 12, 2026 · CC-000031',
        'Book corrected from 8 to 10 (+2)',
        'Item total counted. Which locations were checked was not recorded.',
        'Counted and posted by Blake.',
        '1 recorded stock movement since',
        'Book now: 12',
        'Count this item',
      ]);
    }
  });

  it('a never-counted item answers 200 with lastCount null (a stated answer)', async () => {
    ctxWith({
      'rpc:item_verification_summaries': summaries([
        {
          ...SUMMARY_ROW,
          cycle_count_id: null,
          count_number: null,
          counted_quantity: null,
          expected_quantity: null,
          movements_since: null,
        },
      ]),
    });
    const res = await GET(bearer(URL_), params(ITEM));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.lastCount).toBeNull();
    expect(verificationSummaryCopy(parseItemVerificationSummary(body.summary)).headline).toBe(
      'No physical count on record.',
    );
  });

  it('403 without items:read, before any read', async () => {
    const stub = ctxWith({}, { role: 'viewer', permissions: ['members:read'] });
    const res = await GET(bearer(URL_), params(ITEM));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('403 at a required MFA step-up, with the reason the phone branches on', async () => {
    ctxWith({}, { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    const res = await GET(bearer(URL_), params(ITEM));
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'aal2_required' });
  });

  it('404 when the reader cannot see the item (no row), never an empty summary', async () => {
    ctxWith({ 'rpc:item_verification_summaries': summaries([]) });
    const res = await GET(bearer(URL_), params(ITEM));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
    expect(body.summary).toBeUndefined();
  });

  it('400 for a malformed id', async () => {
    const stub = ctxWith({});
    const res = await GET(bearer('https://t.local/api/v1/items/nope/verification'), params('nope'));
    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it.each([
    [
      'the summary RPC',
      {
        'rpc:item_verification_summaries': {
          data: null,
          error: { message: 'relation "x" permission denied', code: '42501' },
        },
      },
    ],
    [
      'the open exceptions',
      {
        'rpc:item_verification_summaries': summaries([SUMMARY_ROW]),
        'exception_occurrences.select': { data: null, error: { message: 'boom' } },
      },
    ],
    [
      'the checked-at',
      {
        'rpc:item_verification_summaries': summaries([SUMMARY_ROW]),
        'exception_sync_state.select.maybeSingle': { data: null, error: { message: 'boom' } },
      },
    ],
  ])(
    'a failed read of %s is a 500 that says "Couldn\'t load verification" (no raw text, no summary)',
    async (_what, results) => {
      ctxWith(results as Parameters<typeof makeSupabaseStub>[0]);
      const res = await GET(bearer(URL_), params(ITEM));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: 'internal_error', message: "Couldn't load verification" });
      expect(JSON.stringify(body)).not.toMatch(/permission denied|relation|boom/);
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'api.v1.items.verification' }),
      );
    },
  );

  it('staff get the summary without "Count this item"', async () => {
    ctxWith({ 'rpc:item_verification_summaries': summaries([SUMMARY_ROW]) }, { role: 'staff' });
    const body = await (await GET(bearer(URL_), params(ITEM))).json();
    expect([body.canCount, body.countUnavailableReason]).toEqual([false, 'not_permitted']);
    expect(
      verificationSummaryCopy(parseItemVerificationSummary(body.summary), {
        canCount: body.canCount,
      }).countAction,
    ).toBeNull();
  });
});
