// apps/web/src/server/services/team.disabled-status.test.ts
//
// Org-facing visibility for the account-disable program (migs 0308-0313):
// the Team page must show a disabled member's status, so listMembers()
// needs to surface `disabled_at` alongside the rest of the embedded user
// row. Migration 0311 explicitly RETAINS `disabled_at` in the authenticated
// column keep-list (disabled_reason/disabled_by are dropped) — the RLS
// policy `user_profiles_select_orgmates` already lets an org-mate read the
// row, so this is a pure data-shape change, not a new grant.
//
// listMembers() runs on the user-scoped (ctx) client, so it unit-tests
// cleanly with makeSupabaseStub.
//
// setup.ts globally mocks `@/server/services/audit` (no-op) and calls
// vi.restoreAllMocks() after each test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { TeamService } from './team';

describe('TeamService.listMembers — disabled status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces disabled_at from the embedded user row', async () => {
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
            user: {
              id: 'user-1',
              email: 'disabled@example.com',
              full_name: 'Disabled User',
              avatar_url: null,
              disabled_at: '2026-07-30T12:00:00.000Z',
            },
          },
          {
            id: 'member-2',
            role: 'staff',
            invited_at: null,
            accepted_at: '2026-01-01T00:00:00.000Z',
            created_at: '2026-01-01T00:00:00.000Z',
            user_id: 'user-2',
            is_delivery_driver: false,
            all_warehouses: false,
            user: {
              id: 'user-2',
              email: 'active@example.com',
              full_name: 'Active User',
              avatar_url: null,
              disabled_at: null,
            },
          },
        ],
        error: null,
      },
      'user_warehouse_assignments.select': { data: [], error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const members = await svc.listMembers();

    expect(members).toHaveLength(2);
    expect(members[0]?.user?.disabled_at).toBe('2026-07-30T12:00:00.000Z');
    expect(members[1]?.user?.disabled_at).toBeNull();

    // The select string must actually request disabled_at — a member row
    // stays in the list either way (disable never removes membership), so
    // silently dropping the column would regress to the pre-fix behavior
    // with no other test noticing.
    const selectArgs = stub.chainArgs.get('organization_members.select');
    const selectString = selectArgs?.[0]?.[0] as string | undefined;
    expect(selectString).toContain('disabled_at');
  });
});
