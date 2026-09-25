import { describe, expect, it, vi } from 'vitest';

import { fetchCountAssignees } from './count-assignees';

/**
 * The one member source for count assignee pickers (F1-2 made the recount
 * dialog a third caller). Pinned: accepted members of THIS org only, named by
 * full name else email, sorted; a failed read throws (the dialog then says
 * the list could not be loaded instead of offering only "Unassigned").
 */

function client(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not']) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
  return {
    calls,
    supabase: {
      from: vi.fn((table: string) => {
        calls.push(['from', [table]]);
        return chain;
      }),
    },
  };
}

describe('fetchCountAssignees', () => {
  it('reads accepted members of the org, names them and sorts by name', async () => {
    const { supabase, calls } = client({
      data: [
        { user_id: 'u2', user: { id: 'u2', full_name: null, email: 'zed@example.com' } },
        { user_id: 'u1', user: [{ id: 'u1', full_name: 'Ana', email: 'ana@example.com' }] },
        { user_id: 'u3', user: null },
      ],
      error: null,
    });
    const out = await fetchCountAssignees(supabase as never, 'org-1');
    expect(out).toEqual([
      { id: 'u1', name: 'Ana', email: 'ana@example.com' },
      { id: 'u2', name: 'zed@example.com', email: 'zed@example.com' },
    ]);
    expect(calls).toContainEqual(['from', ['organization_members']]);
    expect(calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
    expect(calls).toContainEqual(['not', ['accepted_at', 'is', null]]);
  });

  // Mutation caught: the error ignored (an empty list read as "nobody").
  it('throws on a failed read', async () => {
    const { supabase } = client({ data: null, error: { message: 'boom' } });
    await expect(fetchCountAssignees(supabase as never, 'org-1')).rejects.toThrow(/organization_members read failed/);
  });
});
