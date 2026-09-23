// apps/web/src/server/services/team.list-members-warehouse.test.ts
//
// listMembers() shows one warehouse per member: the row flagged is_primary,
// or, when none is flagged, the FIRST BY ASSIGNMENT ORDER. Rows with no
// primary exist in practice: the 0280 all-warehouses trigger inserts rows with
// is_primary = false, and a member's explicit primary row can be removed after.
//
// The assignment read is batched and paged, so it needs an ORDER BY. Ordering
// by id alone is random uuid order, which picked an arbitrary warehouse for
// such a member. The fake below sorts by the ORDER BY the service asks for, the
// way PostgREST would.
import { describe, expect, it } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { TeamService } from './team';

const OLDER_WH = 'wh-older';
const NEWER_WH = 'wh-newer';

// The OLDER assignment has the LARGER uuid, so an id-ordered read puts the
// newer one first.
const assignments = [
  {
    id: 'ffffffff-0000-4000-8000-000000000001',
    user_id: 'user-1',
    warehouse_id: OLDER_WH,
    charter_id: null,
    is_primary: false,
    assigned_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    user_id: 'user-1',
    warehouse_id: NEWER_WH,
    charter_id: null,
    is_primary: false,
    assigned_at: '2026-06-01T00:00:00.000Z',
  },
];

function sortedLikePostgrest(call: MockCall) {
  const orders: Array<{ col: string; asc: boolean }> = [];
  call.methods.forEach((m, i) => {
    if (m !== 'order') return;
    const [col, opts] = call.args[i] as [string, { ascending?: boolean } | undefined];
    orders.push({ col, asc: opts?.ascending ?? true });
  });
  const rows = [...assignments] as Array<Record<string, unknown>>;
  rows.sort((a, b) => {
    for (const { col, asc } of orders) {
      const x = String(a[col]);
      const y = String(b[col]);
      if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
  const range = callArgs(call, 'range') as [number, number] | undefined;
  return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
}

describe('TeamService.listMembers — fallback warehouse', () => {
  it('shows the earliest assignment when no row is flagged primary', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: [
          {
            id: 'member-1',
            role: 'staff',
            invited_at: null,
            accepted_at: '2026-01-01T00:00:00.000Z',
            created_at: '2026-01-01T00:00:00.000Z',
            user_id: 'user-1',
            is_delivery_driver: false,
            all_warehouses: false,
            user: null,
          },
        ],
        error: null,
      },
      'user_warehouse_assignments.select': sortedLikePostgrest,
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const members = await svc.listMembers();

    expect(members[0]?.warehouse_id).toBe(OLDER_WH);
  });
});
