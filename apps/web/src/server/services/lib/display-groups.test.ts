import { describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

vi.mock('server-only', () => ({}));

import { ORG_MEMBERSHIPS_ONE_READ, readDisplayGroupsForOrgAsMember } from './display-groups';

// Phase 2 of the grouping brief: a staff member's or viewer's page is planned
// group-aware over the whole filtered view, so the plan needs every record's
// display group. This reads the organization's memberships through the
// member's OWN client (RLS decides what they see; never the admin client),
// in ONE request beside the view's scan; past one request's worth it answers
// null and the caller reads by ids (PR #364 review: a big organization must
// not pay a long paged read on every page).

const arg = (call: MockCall, method: string, col?: string) => {
  const i = call.methods.findIndex(
    (m, k) => m === method && (col === undefined || call.args[k]![0] === col),
  );
  return i >= 0 ? call.args[i] : undefined;
};

describe('readDisplayGroupsForOrgAsMember', () => {
  it("reads the organization's memberships through the member's own client, in one request, with each group's name and version", async () => {
    const calls: MockCall[] = [];
    const stub = makeSupabaseStub({
      'item_display_group_members.select': (call) => {
        calls.push(call);
        return {
          data: [
            {
              item_id: 'a',
              group_id: 'g1',
              item_display_groups: { id: 'g1', name: 'Tees', version: 3 },
            },
            {
              item_id: 'b',
              group_id: 'g1',
              item_display_groups: { id: 'g1', name: 'Tees', version: 3 },
            },
          ],
          error: null,
        };
      },
    });
    const map = await readDisplayGroupsForOrgAsMember(stub.client as never, 'org-1');
    expect([...map!.keys()].sort()).toEqual(['a', 'b']);
    expect(map!.get('a')).toMatchObject({ id: 'g1', name: 'Tees', version: 3 });
    expect(calls).toHaveLength(1);
    expect(arg(calls[0]!, 'eq', 'organization_id')).toEqual(['organization_id', 'org-1']);
    expect(String(arg(calls[0]!, 'select')![0])).toContain(
      'item_display_groups!item_display_group_members_group_fk',
    );
    expect(arg(calls[0]!, 'range')).toEqual([0, ORG_MEMBERSHIPS_ONE_READ - 1]);
  });

  it('an organization with a full request of memberships answers null after that one request, so the caller reads by ids', async () => {
    const calls: MockCall[] = [];
    const stub = makeSupabaseStub({
      'item_display_group_members.select': (call) => {
        calls.push(call);
        // A paged read would come back for the rest.
        if (calls.length > 1) return { data: [], error: null };
        return {
          data: Array.from({ length: ORG_MEMBERSHIPS_ONE_READ }, (_x, i) => ({
            item_id: `i${i}`,
            group_id: 'g1',
            item_display_groups: { id: 'g1', name: 'Tees', version: 1 },
          })),
          error: null,
        };
      },
    });
    expect(await readDisplayGroupsForOrgAsMember(stub.client as never, 'org-1')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a failed read renders the records ungrouped instead of failing the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = makeSupabaseStub({
      'item_display_group_members.select': { data: null, error: { message: 'boom' } },
    });
    const map = await readDisplayGroupsForOrgAsMember(stub.client as never, 'org-1');
    expect(map!.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
