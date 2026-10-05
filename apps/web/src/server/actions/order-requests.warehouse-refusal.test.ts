import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describePartialCommitRefusal,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  PARTIAL_COMMIT_FAILED_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Small fixes slice 2 review: the order service refuses a change outside the
 * caller's warehouses with a ForbiddenError (lib/auth/warehouse), not a
 * ServiceError, so every route answers 403. The server actions' toResult
 * turned it into 'internal_error', and the web's Approve partial and Resume
 * dialog shows core's "The order could not be updated. Try again." for that
 * code: a permanent refusal read as a fault to retry. It is 'forbidden' with
 * the service's sentence now, as the cycle-count and attachment actions
 * already answer it.
 *
 * The REAL actions, service and warehouse helpers against a Supabase stub: a
 * staff member granted orders:approve, assigned to wh-a, on an order in wh-b.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { approveOrderPartialAction, cancelOrderRequestAction, resumeFulfillmentAction } from './order-requests';

const ORDER = '44444444-4444-4444-8444-444444444444';

function arrange() {
  const stub = makeSupabaseStub({
    'order_requests.select.maybeSingle': {
      data: { warehouse_id: 'wh-b', status: 'approved', requester_user_id: 'someone-else' },
      error: null,
    },
    'user_warehouse_assignments.select': { data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null },
    'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: 'staff',
      userId: 'appr-1',
      enabledModules: new Set<ModuleId>(['orders']),
      permissions: new Set(['orders:request', 'orders:approve']),
    }) as never,
  );
  return stub;
}

beforeEach(() => vi.clearAllMocks());

describe('a refusal outside the caller\'s warehouses reaches the web as forbidden, with its sentence', () => {
  it.each([
    ['approveOrderPartialAction', () => approveOrderPartialAction({ id: ORDER })],
    ['resumeFulfillmentAction', () => resumeFulfillmentAction({ id: ORDER })],
    ['cancelOrderRequestAction', () => cancelOrderRequestAction({ id: ORDER, reason: null })],
  ] as const)('%s', async (_name, run) => {
    const stub = arrange();
    const res = await run();
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: ORDER_WAREHOUSE_WRITE_REFUSED_COPY },
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('so the Approve partial and Resume dialog shows the sentence, not "Try again"', async () => {
    arrange();
    const res = await approveOrderPartialAction({ id: ORDER });
    if (res.ok) throw new Error('expected a refusal');
    const shown = describePartialCommitRefusal({ answered: true, code: res.error.code, message: res.error.message });
    expect(shown).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(shown).not.toBe(PARTIAL_COMMIT_FAILED_COPY);
  });
});
