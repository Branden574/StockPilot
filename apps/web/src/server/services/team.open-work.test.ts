// apps/web/src/server/services/team.open-work.test.ts
//
// B94: the Remove dialog asks, when it opens, how much open work removing the
// person releases: public.member_open_work (migration 0429), which counts with
// the same predicates the release itself uses and answers only an admin who
// holds members:remove in that organization. The read fails CLOSED (recurring
// pattern #1): a refusal is its own answer, and any other failure (the
// function missing before the migration is pushed, a network error, an answer
// of the wrong shape) is "failed", logged, never a throw that breaks the
// dialog and never a count of zero.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => null }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: 't' })) }));

import { TeamService } from './team';

const ORG = '11111111-1111-1111-1111-111111111111';
const MEMBER_ROW_ID = '44444444-4444-4444-4444-444444444444';

const COUNTS = {
  cycleCounts: 1,
  picks: 2,
  deliveries: 3,
  scheduleEvents: 1,
  maintenanceRequests: 0,
  escalationClaims: 1,
  warehouses: 1,
};

function service(rpc: { data: unknown; error: { message: string; code?: string } | null }) {
  const stub = makeSupabaseStub({ 'rpc:member_open_work': rpc });
  return {
    stub,
    svc: new TeamService(makeServiceContext(stub.client, { role: 'admin', organizationId: ORG })),
  };
}

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe('TeamService.openWork', () => {
  it('returns the seven numbers for the membership row it was asked about', async () => {
    const { svc, stub } = service({ data: COUNTS, error: null });

    await expect(svc.openWork(MEMBER_ROW_ID)).resolves.toEqual({ kind: 'ok', counts: COUNTS });
    expect(stub.rpcCalls).toEqual([
      { name: 'member_open_work', args: { p_member_id: MEMBER_ROW_ID } },
    ]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('says forbidden when the database refuses the caller (42501 forbidden)', async () => {
    const { svc } = service({ data: null, error: { message: 'forbidden', code: '42501' } });

    await expect(svc.openWork(MEMBER_ROW_ID)).resolves.toEqual({ kind: 'forbidden' });
  });

  it.each([
    [
      'the function is missing (before the migration)',
      { message: 'Could not find the function', code: 'PGRST202' },
    ],
    [
      'the row is not in an organization the caller belongs to',
      { message: 'member_not_found', code: 'P0002' },
    ],
    ['no subject', { message: 'unauthenticated', code: '42501' }],
    ['a network failure', { message: '' }],
  ])('fails closed and logs it when %s', async (_why, error) => {
    const { svc } = service({ data: null, error });

    await expect(svc.openWork(MEMBER_ROW_ID)).resolves.toEqual({ kind: 'failed' });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an answer of the wrong shape, never reading it as zero', async () => {
    for (const data of [null, {}, { ...COUNTS, picks: 'two' }, { ...COUNTS, deliveries: -1 }]) {
      const { svc } = service({ data, error: null });
      await expect(svc.openWork(MEMBER_ROW_ID)).resolves.toEqual({ kind: 'failed' });
    }
    expect(logged).toHaveBeenCalledTimes(4);
  });
});
