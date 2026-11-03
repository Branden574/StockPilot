import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE PHONE'S RELEASE SHEET IS ANSWERED, THROUGH THE REAL SERVICE.
//
// route.test.ts mocks CycleCountsService and pins the route's own branches.
// This file runs the real route over the real CycleCountsService.release,
// down to the release_cycle_count call and the count read on a stub client,
// and pins the status and body the phone's release sheet
// (apps/mobile/src/components/cycle-count-release-sheet.tsx) shows: api()
// throws the body's `message` and the sheet shows it as it is.
//
// Docket S42b: since S42's migration the database refuses a non-manager on a
// count with no assignee. An assignee meets that when their own release went
// through but its answer was lost (the phone stops waiting after 20 seconds,
// or the connection drops) and they tap Release count again, or when a
// manager released the count while their screen was open. They are told the
// count was already released (409), not that only the assignee may release
// it (403); nothing is written and no second audit row is made.
//
// S39: before the function, release() reads the count in the active
// organization (its id only). A count that read does not find (outside the
// caller's organizations, or in another organization the caller belongs to)
// answers 404 'Cycle count not found.' with no function call.
// ═══════════════════════════════════════════════════════════════════════════

const CC = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';
const ME = 'u-1';
const ALREADY_RELEASED = { error: 'conflict', message: 'This count was already released.' };
const GENERIC = {
  error: 'forbidden',
  message: 'Only the assigned employee or a manager can release this count.',
};
const NOT_FOUND = { error: 'not_found', message: 'Cycle count not found.' };
const REFUSED: QueryResult = { data: null, error: { message: 'forbidden', code: '42501' } };
/** The read in the active organization before the function (S39). */
const IN_ORG_READ = [['id'], ['organization_id', ORG], ['id', CC]];

type CountRow = {
  id: string;
  organization_id: string;
  status: 'in_progress' | 'completed' | 'canceled';
  assigned_to: string | null;
};
const count = (over: Partial<CountRow> = {}): CountRow => ({
  id: CC,
  organization_id: ORG,
  status: 'in_progress',
  assigned_to: null,
  ...over,
});

/** A staff member (stock:adjust, the release floor) on the phone. */
function signedInAs(stub: ReturnType<typeof makeSupabaseStub>, userId = ME) {
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      organizationId: ORG,
      userId,
      role: 'staff',
      enabledModules: new Set<ModuleId>(['cycle_counts']),
    }) as never,
  );
}

async function release() {
  const res = await POST(
    new Request(`https://test.local/api/v1/cycle-counts/${CC}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Shift ending' }),
    }) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: CC }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
});

describe('POST /api/v1/cycle-counts/[id]/release, as the phone release sheet reads it', () => {
  it('the assignee sends Release count again after their first release went through: 409, already released, one audit row', async () => {
    // The database as S42 leaves it: the assignee's own release clears the
    // assignment; the same call again finds no assignee and is refused.
    let row = count({ assigned_to: ME });
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': () => {
        if (row.assigned_to !== ME) return REFUSED;
        row = { ...row, assigned_to: null };
        return { data: row, error: null };
      },
      'cycle_counts.select': servedLikePostgrest(() => [row]),
    });
    signedInAs(stub);

    const first = await release();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, cycleCount: count({ assigned_to: null }) });

    const again = await release();
    expect(again).toEqual({ status: 409, body: ALREADY_RELEASED });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stub.rpcCalls).toHaveLength(2);
    expect([...stub.chainsAll.keys()]).toEqual(['cycle_counts.select']);
  });

  it('a manager released the count while the sheet was open: 409, already released, nothing written', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ assigned_to: null })]),
    });
    signedInAs(stub);
    expect(await release()).toEqual({ status: 409, body: ALREADY_RELEASED });
    expect(audit).not.toHaveBeenCalled();
    expect([...stub.chainsAll.keys()]).toEqual(['cycle_counts.select']);
  });

  it('a member who can read the count but was never its assignee: 403 with the same words as before', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ assigned_to: 'someone-else' })]),
    });
    signedInAs(stub);
    expect(await release()).toEqual({ status: 403, body: GENERIC });
    expect(audit).not.toHaveBeenCalled();
  });

  it("someone outside the count's organization (row level security shows them nothing): 404 not found, before the function", async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([]),
    });
    signedInAs(stub, 'outsider');
    expect(await release()).toEqual({ status: 404, body: NOT_FOUND });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a closed count: 409 with its own words, and no refusal's read of the count", async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': {
        data: null,
        error: { message: 'invalid_status_transition', code: 'P0001', details: 'completed' },
      },
      'cycle_counts.select': servedLikePostgrest([count({ status: 'completed' })]),
    });
    signedInAs(stub);
    expect(await release()).toEqual({
      status: 409,
      body: { error: 'conflict', message: "This cycle count is closed — it can't be released." },
    });
    // Only the read in the organization before the function.
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([IN_ORG_READ]);
    expect(audit).not.toHaveBeenCalled();
  });
});
